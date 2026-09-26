// Curation backlog report: turns the inventory-coverage gap into a per-owner checklist.
//
// Classifies every active repo in github-meta.json (with inventory-extra.json fallbacks):
//   uncurated   no inventory topics at all, so invisible to the map
//   incomplete  has a type (so it is on the map) but lacks owner, status or description
// Archived and `arch-map-ignore` repos are genuine non-components and are skipped.
//
// Prints GitHub-flavoured Markdown to stdout. The curation-report.yml workflow runs it weekly and
// updates a tracking issue. Run locally with `node scripts/curation-report.mjs`.
import fs from 'node:fs'
import path from 'node:path'
import { AUDIT } from './_paths.mjs'
import { parseTopics, TOPIC_MAPS } from './inventory.mjs'

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const meta = readJson(path.join(AUDIT, 'github-meta.json'))
const extra = readJson(path.join(AUDIT, 'inventory-extra.json')) || { repoExtras: {} }

if (!meta?.repos) {
  console.error('curation-report: no github-meta.json — run `npm run regenerate` first')
  process.exit(1)
}

// Owners configured in config.json `owners` keep their name; any other owner prints as-is.
const OWNER_LABEL = Object.fromEntries(Object.keys(TOPIC_MAPS.owner).map((name) => [name, name]))
const ownerLabel = (owner) => OWNER_LABEL[owner] || owner || '— (no owner topic)'

const isActive = (repo) => !repo.archived && !(repo.topics || []).includes('arch-map-ignore')
const byName = (a, b) => a.name.localeCompare(b.name)

const hasInventoryTopics = (topics) =>
  topics.type || topics.status || topics.owner || topics.applications.length || topics.cluster

// Returns 'uncurated', { owner, missing } for a half-curated repo, or null when nothing is due.
function classifyRepo(name, repo) {
  const topics = parseTopics(repo.topics)
  const repoExtra = extra.repoExtras?.[name]
  const fallback = repoExtra?.fallback || {}
  if (!hasInventoryTopics(topics) && !repoExtra && !repo.props) return 'uncurated'
  // Owner, app or cluster topics without a type don't put a repo on the map either.
  if (!(topics.type || fallback.type)) return null
  const owner = topics.owner || fallback.owner
  const missing = []
  if (!owner) missing.push('owner')
  if (!(topics.status || fallback.status)) missing.push('status')
  if (!(repo.description || fallback.description)) missing.push('description')
  return missing.length ? { owner, missing } : null
}

const uncurated = [] // { name }
const incomplete = [] // { name, owner, missing }
for (const [name, repo] of Object.entries(meta.repos)) {
  if (!isActive(repo)) continue
  const verdict = classifyRepo(name, repo)
  if (verdict === 'uncurated') uncurated.push({ name })
  else if (verdict) incomplete.push({ name, ...verdict })
}

const total = Object.values(meta.repos).filter(isActive).length
const curated = total - uncurated.length

function summarySection() {
  return [
    '# Curation backlog',
    '',
    `Snapshot from \`github-meta.json\` (${meta.generatedAt?.slice(0, 10) || 'n/a'}). ` +
      `**${curated}/${total}** active repos carry inventory topics; **${uncurated.length}** are invisible to the map ` +
      `and **${incomplete.length}** are half-curated.`,
    '',
    'See [`docs/repo-maintenance.md`](docs/repo-maintenance.md) for how to curate a repo.',
    '',
  ]
}

function incompleteSection() {
  const lines = [
    '## On the map but half-curated',
    '',
    'Already have a `type-*` so they render — finish the rest.',
    '',
  ]
  const reposByOwner = new Map()
  for (const repo of incomplete) {
    const label = ownerLabel(repo.owner)
    if (!reposByOwner.has(label)) reposByOwner.set(label, [])
    reposByOwner.get(label).push(repo)
  }
  for (const owner of [...reposByOwner.keys()].sort()) {
    lines.push(`### ${owner}`, '')
    for (const repo of reposByOwner.get(owner).sort(byName)) {
      lines.push(`- [ ] \`${repo.name}\` — add ${repo.missing.join(', ')}`)
    }
    lines.push('')
  }
  return lines
}

function uncuratedSection() {
  return [
    '## Uncurated — not on the map',
    '',
    'No inventory topics. Add at minimum a one-line description + a `type-*` topic ' +
      '(`type-client`/`service`/`library`/`firmware`/`infra`/`hardware`/`data`/`config`/…), ' +
      'plus `owner-*`, `status-*`, `app-*`. Genuine non-components (PoCs, demos, dev tooling) ' +
      'should be archived or tagged `arch-map-ignore`.',
    '',
    ...uncurated.sort(byName).map((repo) => `- [ ] \`${repo.name}\``),
    '',
  ]
}

const lines = summarySection()
if (incomplete.length) lines.push(...incompleteSection())
if (uncurated.length) lines.push(...uncuratedSection())
if (!incomplete.length && !uncurated.length) {
  lines.push('🎉 Every active repo is fully curated. Nothing to do.', '')
}

process.stdout.write(lines.join('\n'))
