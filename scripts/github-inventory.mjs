// GitHub org inventory gather — repo descriptions + topics become the live source of the
// Component Inventory (replacing the hand-maintained component-inventory.csv).
//
// Topic schema (lowercase, dashes — GitHub topic rules):
//   type-client | type-service | type-third-party-service | type-library | type-assets | type-tests
//   type-firmware | type-infra | type-hardware | type-data | type-config
//   status-current | status-planned | status-sunsetting | status-removed
//   owner-css-at | owner-iss | ...          (team, dots -> dashes)
//   app-skytrack | app-ci | ...            (one per application the component serves)
// Non-topic-able fields (contact, dates, comments, review trail) and components without a
// repo live in inventory-extra.json (see migrate-inventory.mjs / inventory.mjs).
//
// One API call fetches every org repo with description + topics -> github-meta.json.
// Same degrade/caching pattern as the other gathers: skips without gh auth, 1h cache,
// ATLAS_GH=force to refresh, ATLAS_GH=0 to disable.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { AUDIT, ORG } from './_paths.mjs'

const OUT = path.join(AUDIT, 'github-meta.json')
const execFileP = promisify(execFile)
const MAX_AGE_MS = 60 * 60 * 1000

if (process.env.ATLAS_GH === '0') { console.log('github-inventory: disabled (ATLAS_GH=0)'); process.exit(0) }
if (process.env.ATLAS_GH !== 'force' && fs.existsSync(OUT)) {
  const age = Date.now() - fs.statSync(OUT).mtimeMs
  if (age < MAX_AGE_MS) { console.log(`github-inventory: github-meta.json is ${Math.round(age / 60000)}min old, skipping (ATLAS_GH=force to refresh)`); process.exit(0) }
}

// gh auth: fall back to the keyring when a scoped-down GITHUB_TOKEN env var shadows it
const run = async (env) => JSON.parse((await execFileP('gh',
  ['repo', 'list', ORG, '--limit', '400', '--json', 'name,description,url,isArchived,repositoryTopics,defaultBranchRef,pushedAt,createdAt,primaryLanguage'],
  { env, maxBuffer: 1024 * 1024 * 32 })).stdout)

// Prefer the keyring login: a scoped-down GITHUB_TOKEN env var (e.g. packages-only) doesn't
// error — it silently sees only a handful of repos. In CI there is no keyring, so the env
// token (GH_TOKEN/GITHUB_TOKEN) is the fallback.
let list
const { GITHUB_TOKEN, ...noEnvToken } = process.env
try { list = await run(noEnvToken) } catch {
  try { list = await run(process.env) }
  catch { console.log('github-inventory: gh CLI not available or no org access — skipping'); process.exit(0) }
}
if (!list?.length) { console.log('github-inventory: org list came back empty — keeping previous github-meta.json'); process.exit(0) }

const repos = {}
for (const r of list) {
  const topics = (r.repositoryTopics || []).map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean)
  const defaultBranch = r.defaultBranchRef?.name || null
  repos[r.name] = {
    description: r.description || '', url: r.url, archived: !!r.isArchived, topics, defaultBranch,
    pushedAt: r.pushedAt || null, createdAt: r.createdAt || null,
    // GitHub's primary language — the zero-curation fallback for the derived `language` inventory
    // field (assemble.mjs refines it from build files / toolingVersions where those are scanned)
    language: r.primaryLanguage?.name || null,
  }
}

// Transient-failure guard for the per-repo API calls: a rate-limited or flaky call otherwise
// degrades to a silently dropped field (props carried over, health missing) and the diff churns.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withRetry = async (fn, tries = 3) => {
  for (let attempt = 1; ; attempt++) {
    try { return await fn() } catch (e) {
      if (attempt >= tries) throw e
      await sleep(attempt * 2000) // 2s, 4s — enough for a secondary-rate-limit breather
    }
  }
}

// org custom property values (technical-contact, abbreviation, doc-url, doc-label) -> props per repo.
// If the listing isn't readable with the current token, carry over the previous values
// so a CI refresh can never silently drop them.
let propsRead = false
try {
  for (let page = 1; page <= 30; page++) {
    const { stdout } = await withRetry(() => execFileP('gh', ['api', `orgs/${ORG}/properties/values?per_page=100&page=${page}`],
      { env: noEnvToken, maxBuffer: 1024 * 1024 * 16 }))
    const batch = JSON.parse(stdout)
    for (const r of batch) {
      if (!repos[r.repository_name]) continue
      const props = Object.fromEntries((r.properties || []).filter((p) => p.value != null && p.value !== '').map((p) => [p.property_name, p.value]))
      if (Object.keys(props).length) repos[r.repository_name].props = props
    }
    propsRead = true
    if (batch.length < 100) break
    if (page === 30) console.warn('github-inventory: property listing hit the 30-page cap — raise it')
  }
} catch {
  try {
    // Fill only repos with no freshly-fetched props: a failure on page N must not overwrite the
    // pages already applied this run with last night's values.
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'))
    for (const [name, r] of Object.entries(prev.repos || {})) if (r.props && repos[name] && !repos[name].props) repos[name].props = r.props
    console.log('github-inventory: property listing not readable — carried over previous custom-property values')
  } catch {}
}

// ---- health signals: Dependabot alerts + latest CI run, per repo ---------------------------
// Only for repos that are (or will be) on the map — i.e. carry an inventory topic — to bound the
// API calls (~2 per repo). pushedAt/defaultBranch already came free from the list above. Each call
// degrades independently: no access / no data leaves that sub-field undefined rather than failing.
const api = async (endpoint) => JSON.parse((await withRetry(() => execFileP('gh', ['api', endpoint], { env: noEnvToken, maxBuffer: 1024 * 1024 * 16 }))).stdout)
const curated = Object.entries(repos).filter(([, r]) => !r.archived && r.topics.some((t) => /^(type|status|owner|app)-/.test(t)))
const alertsFor = async (name) => {
  try {
    // Paginate: a single 100-row page under-reports alert-heavy repos. 5-page cap (500 alerts)
    // is plenty for a severity summary — beyond it the count is just "a lot".
    const rows = []
    for (let page = 1; page <= 5; page++) {
      const batch = await api(`repos/${ORG}/${name}/dependabot/alerts?state=open&per_page=100&page=${page}`)
      rows.push(...batch)
      if (batch.length < 100) break
    }
    const by = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const a of rows) { const s = a?.security_advisory?.severity; if (s in by) by[s]++ }
    return { total: rows.length, ...by }
  } catch { return undefined } // Dependabot disabled or no access
}
const ciFor = async (name, branch) => {
  if (!branch) return undefined
  try {
    const d = await api(`repos/${ORG}/${name}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`)
    const run = d.workflow_runs?.[0]
    return run ? { conclusion: run.conclusion, status: run.status, at: run.created_at, url: run.html_url } : undefined
  } catch { return undefined } // no Actions
}
// simple concurrency pool so ~100 repos × 2 calls don't run serially or all-at-once
let healthOk = 0
const POOL = 8
for (let i = 0; i < curated.length; i += POOL) {
  await Promise.all(curated.slice(i, i + POOL).map(async ([name, r]) => {
    const [alerts, ci] = await Promise.all([alertsFor(name), ciFor(name, r.defaultBranch)])
    if (alerts || ci) { r.health = { ...(alerts ? { alerts } : {}), ...(ci ? { ci } : {}) }; healthOk++ }
  }))
}

fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), org: ORG, repos }, null, 2))
console.log(`  health signals fetched for ${healthOk}/${curated.length} curated repos`)
const withTopics = Object.values(repos).filter((r) => r.topics.some((t) => /^(type|status|owner|app)-/.test(t))).length
const withProps = Object.values(repos).filter((r) => r.props).length
console.log(`wrote github-meta.json; repos: ${Object.keys(repos).length}, with inventory topics: ${withTopics}, with custom properties: ${withProps}${propsRead ? '' : ' (carried over)'}`)
