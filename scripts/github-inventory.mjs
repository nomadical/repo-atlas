// GitHub org inventory gather: repo descriptions and topics are the live source of the Component
// Inventory.
//
// Topic schema (lowercase, dashes, per GitHub topic rules):
//   type-client | type-service | type-third-party-service | type-library | type-assets | type-tests
//   type-firmware | type-infra | type-hardware | type-data | type-config
//   status-current | status-planned | status-sunsetting | status-removed
//   owner-css-at | owner-iss | ...          (team, dots -> dashes)
//   app-skytrack | app-ci | ...            (one per application the component serves)
// Fields topics can't hold (contact, dates, comments, review trail) and components without a repo
// live in inventory-extra.json (see inventory.mjs).
//
// Writes github-meta.json. Skips without gh auth, caches for an hour, ATLAS_GH=force refreshes and
// ATLAS_GH=0 disables it.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { AUDIT, ORG } from './_paths.mjs'

const OUT = path.join(AUDIT, 'github-meta.json')
const execFileAsync = promisify(execFile)
const MAX_AGE_MS = 60 * 60 * 1000
const MS_PER_MINUTE = 60000
const ORG_REPO_LIMIT = '400'
const REPO_FIELDS =
  'name,description,url,isArchived,repositoryTopics,defaultBranchRef,pushedAt,createdAt,primaryLanguage'
const LIST_MAX_BUFFER = 1024 * 1024 * 32
const API_MAX_BUFFER = 1024 * 1024 * 16
const PAGE_SIZE = 100
const MAX_PROPERTY_PAGES = 30
// 500 alerts is plenty for a severity summary; beyond it the count just means "a lot".
const MAX_ALERT_PAGES = 5
const RETRY_ATTEMPTS = 3
const RETRY_BACKOFF_MS = 2000
// Repos whose health is fetched in parallel (about two API calls each).
const HEALTH_BATCH_SIZE = 8
const INVENTORY_TOPIC_PATTERN = /^(type|status|owner|app)-/

const exitIfDisabledOrFresh = () => {
  if (process.env.ATLAS_GH === '0') {
    console.log('github-inventory: disabled (ATLAS_GH=0)')
    process.exit(0)
  }
  if (process.env.ATLAS_GH === 'force' || !fs.existsSync(OUT)) return
  const ageMs = Date.now() - fs.statSync(OUT).mtimeMs
  if (ageMs >= MAX_AGE_MS) return
  console.log(
    `github-inventory: github-meta.json is ${Math.round(ageMs / MS_PER_MINUTE)}min old, skipping (ATLAS_GH=force to refresh)`,
  )
  process.exit(0)
}

exitIfDisabledOrFresh()

// The keyring login comes first: a scoped-down GITHUB_TOKEN env var (e.g. packages-only) doesn't
// error, it silently sees only a handful of repos. CI has no keyring, so there the env token
// (GH_TOKEN/GITHUB_TOKEN) is the fallback.
const { GITHUB_TOKEN: _envToken, ...envWithoutToken } = process.env

const listOrgRepos = async (env) => {
  const { stdout } = await execFileAsync(
    'gh',
    ['repo', 'list', ORG, '--limit', ORG_REPO_LIMIT, '--json', REPO_FIELDS],
    { env, maxBuffer: LIST_MAX_BUFFER },
  )
  return JSON.parse(stdout)
}

const listOrgReposWithFallback = async () => {
  try {
    return await listOrgRepos(envWithoutToken)
  } catch {}
  try {
    return await listOrgRepos(process.env)
  } catch {
    console.log('github-inventory: gh CLI not available or no org access — skipping')
    process.exit(0)
  }
}

const orgRepos = await listOrgReposWithFallback()
if (!orgRepos?.length) {
  console.log('github-inventory: org list came back empty — keeping previous github-meta.json')
  process.exit(0)
}

const topicNames = (repositoryTopics) =>
  (repositoryTopics || []).map((topic) => (typeof topic === 'string' ? topic : topic?.name)).filter(Boolean)

const toRepoMeta = (repo) => ({
  description: repo.description || '',
  url: repo.url,
  archived: !!repo.isArchived,
  topics: topicNames(repo.repositoryTopics),
  defaultBranch: repo.defaultBranchRef?.name || null,
  pushedAt: repo.pushedAt || null,
  createdAt: repo.createdAt || null,
  // Zero-curation fallback; assemble.mjs refines it from build files where those are scanned.
  language: repo.primaryLanguage?.name || null,
})

// Written to github-meta.json as-is, so it stays a plain object keyed by repo name.
const repos = {}
for (const repo of orgRepos) repos[repo.name] = toRepoMeta(repo)
// Own keys only: a repo named like `constructor` must not resolve to a built-in.
const repoNamed = (name) => (Object.hasOwn(repos, name) ? repos[name] : undefined)

// A rate-limited or flaky per-repo call would otherwise silently drop a field and churn the diff.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const withRetry = async (fn, attempts = RETRY_ATTEMPTS) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= attempts) throw error
      // 2s, then 4s: enough for a secondary-rate-limit breather.
      await sleep(attempt * RETRY_BACKOFF_MS)
    }
  }
}

const ghApi = async (endpoint) => {
  const { stdout } = await withRetry(() =>
    execFileAsync('gh', ['api', endpoint], { env: envWithoutToken, maxBuffer: API_MAX_BUFFER }),
  )
  return JSON.parse(stdout)
}

// ---- Custom properties (technical-contact, abbreviation, doc-url, doc-label) ------------------
let propsCarriedOver = false

const nonEmptyProps = (properties) =>
  Object.fromEntries(
    (properties || [])
      .filter((property) => property.value != null && property.value !== '')
      .map((property) => [property.property_name, property.value]),
  )

const applyCustomProperties = async () => {
  for (let page = 1; page <= MAX_PROPERTY_PAGES; page++) {
    const batch = await ghApi(`orgs/${ORG}/properties/values?per_page=${PAGE_SIZE}&page=${page}`)
    for (const entry of batch) {
      const repo = repoNamed(entry.repository_name)
      if (!repo) continue
      const props = nonEmptyProps(entry.properties)
      if (Object.keys(props).length) repo.props = props
    }
    if (batch.length < PAGE_SIZE) break
    if (page === MAX_PROPERTY_PAGES) {
      console.warn(`github-inventory: property listing hit the ${MAX_PROPERTY_PAGES}-page cap — raise it`)
    }
  }
}

// Fills only repos without freshly fetched props: a failure on page N must not overwrite the pages
// already applied this run with last night's values.
const carryOverPreviousProps = () => {
  try {
    const previous = JSON.parse(fs.readFileSync(OUT, 'utf8'))
    for (const [name, previousRepo] of Object.entries(previous.repos || {})) {
      const repo = repoNamed(name)
      if (previousRepo.props && repo && !repo.props) repo.props = previousRepo.props
    }
    propsCarriedOver = true
    console.log(
      'github-inventory: property listing not readable — carried over previous custom-property values',
    )
  } catch {}
}

// If the listing isn't readable with the current token, the previous values are carried over so a
// CI refresh can never silently drop them.
try {
  await applyCustomProperties()
} catch {
  carryOverPreviousProps()
}

// ---- Health signals: Dependabot alerts and latest CI run -------------------------------------
// Only repos that carry an inventory topic, to bound the API calls. Each call degrades on its own:
// no access or no data leaves that sub-field out rather than failing.
const hasInventoryTopic = (repo) => repo.topics.some((topic) => INVENTORY_TOPIC_PATTERN.test(topic))

const curated = Object.entries(repos).filter(([, repo]) => !repo.archived && hasInventoryTopic(repo))

// Undefined when Dependabot is disabled or not accessible.
const alertsFor = async (name) => {
  try {
    // A single page under-reports alert-heavy repos.
    const alerts = []
    for (let page = 1; page <= MAX_ALERT_PAGES; page++) {
      const batch = await ghApi(
        `repos/${ORG}/${name}/dependabot/alerts?state=open&per_page=${PAGE_SIZE}&page=${page}`,
      )
      alerts.push(...batch)
      if (batch.length < PAGE_SIZE) break
    }
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const alert of alerts) {
      const severity = alert?.security_advisory?.severity
      if (Object.hasOwn(bySeverity, severity)) bySeverity[severity]++
    }
    return { total: alerts.length, ...bySeverity }
  } catch {
    return undefined
  }
}

// Undefined when the repo has no Actions runs or they aren't accessible.
const ciFor = async (name, branch) => {
  if (!branch) return undefined
  try {
    const runs = await ghApi(
      `repos/${ORG}/${name}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`,
    )
    const latestRun = runs.workflow_runs?.[0]
    if (!latestRun) return undefined
    return {
      conclusion: latestRun.conclusion,
      status: latestRun.status,
      at: latestRun.created_at,
      url: latestRun.html_url,
    }
  } catch {
    return undefined
  }
}

let healthFetchedCount = 0

const addHealth = async ([name, repo]) => {
  const [alerts, ci] = await Promise.all([alertsFor(name), ciFor(name, repo.defaultBranch)])
  if (!alerts && !ci) return
  repo.health = { ...(alerts ? { alerts } : {}), ...(ci ? { ci } : {}) }
  healthFetchedCount++
}

for (let start = 0; start < curated.length; start += HEALTH_BATCH_SIZE) {
  await Promise.all(curated.slice(start, start + HEALTH_BATCH_SIZE).map(addHealth))
}

fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), org: ORG, repos }, null, 2))
console.log(`  health signals fetched for ${healthFetchedCount}/${curated.length} curated repos`)
const allRepos = Object.values(repos)
const withTopicsCount = allRepos.filter(hasInventoryTopic).length
const withPropsCount = allRepos.filter((repo) => repo.props).length
console.log(
  `wrote github-meta.json; repos: ${Object.keys(repos).length}, with inventory topics: ${withTopicsCount}, with custom properties: ${withPropsCount}${propsCarriedOver ? ' (carried over)' : ''}`,
)
