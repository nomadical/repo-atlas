// Curation backlog report — turns the inventory-coverage gap into an actionable, per-owner
// checklist so curation gets DONE instead of sitting as ambient debt.
//
// Reads github-meta.json (the full org snapshot, refreshed nightly by github-inventory.mjs) and
// inventory-extra.json, then classifies every active repo:
//   • uncurated   — no inventory topics at all (invisible to the map; needs the full set)
//   • incomplete  — has a type-* (so it IS on the map) but missing owner/status/description
// Archived repos and `arch-map-ignore` repos are excluded (genuine non-components).
//
// Prints GitHub-flavoured Markdown to stdout. The curation-report.yml workflow runs this weekly
// and opens/updates a tracking issue. Run locally any time: `node scripts/curation-report.mjs`.
import fs from 'node:fs'
import path from 'node:path'
import { AUDIT } from './_paths.mjs'
import { parseTopics, TOPIC_MAPS } from './inventory.mjs'

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const meta = readJson(path.join(AUDIT, 'github-meta.json'))
const extra = readJson(path.join(AUDIT, 'inventory-extra.json')) || { repoExtras: {} }

if (!meta?.repos) { console.error('curation-report: no github-meta.json — run `npm run regenerate` first'); process.exit(1) }

// owner-* value (as parseTopics produces it) -> a readable label for the report's grouping.
// Your team vocabulary lives in config.json `owners`, so read it from there; an owner with no
// entry prints as-is, which is usually already readable.
const OWNER_LABEL = Object.fromEntries(Object.keys(TOPIC_MAPS.owner).map((name) => [name, name]))
const ownerLabel = (o) => OWNER_LABEL[o] || o || '— (no owner topic)'

const uncurated = [] // { name }
const incomplete = [] // { name, owner, missing[] }

for (const [name, r] of Object.entries(meta.repos)) {
  if (r.archived || (r.topics || []).includes('arch-map-ignore')) continue
  const t = parseTopics(r.topics)
  const ex = extra.repoExtras?.[name]
  const fb = ex?.fallback || {}
  const hasInvTopics = t.type || t.status || t.owner || t.applications.length || t.cluster
  if (!hasInvTopics && !ex && !r.props) { uncurated.push({ name }); continue }
  // on the map (has a type, possibly via fallback) but half-curated?
  const type = t.type || fb.type
  if (!type) continue // owner/app/cluster only, no type — still effectively uncurated for the map
  const owner = t.owner || fb.owner
  const description = r.description || fb.description
  const status = t.status || fb.status
  const missing = []
  if (!owner) missing.push('owner')
  if (!status) missing.push('status')
  if (!description) missing.push('description')
  if (missing.length) incomplete.push({ name, owner, missing })
}

const total = Object.values(meta.repos).filter((r) => !r.archived && !(r.topics || []).includes('arch-map-ignore')).length
const curated = total - uncurated.length

const lines = []
lines.push('# Curation backlog', '')
lines.push(`Snapshot from \`github-meta.json\` (${meta.generatedAt?.slice(0, 10) || 'n/a'}). `
  + `**${curated}/${total}** active repos carry inventory topics; **${uncurated.length}** are invisible to the map `
  + `and **${incomplete.length}** are half-curated.`, '')
lines.push('See [`docs/repo-maintenance.md`](docs/repo-maintenance.md) for how to curate a repo.', '')

if (incomplete.length) {
  lines.push('## On the map but half-curated', '', 'Already have a `type-*` so they render — finish the rest.', '')
  const byOwner = {}
  for (const c of incomplete) (byOwner[ownerLabel(c.owner)] ||= []).push(c)
  for (const owner of Object.keys(byOwner).sort()) {
    lines.push(`### ${owner}`, '')
    for (const c of byOwner[owner].sort((a, b) => a.name.localeCompare(b.name))) lines.push(`- [ ] \`${c.name}\` — add ${c.missing.join(', ')}`)
    lines.push('')
  }
}

if (uncurated.length) {
  lines.push('## Uncurated — not on the map', '',
    'No inventory topics. Add at minimum a one-line description + a `type-*` topic '
    + '(`type-client`/`service`/`library`/`firmware`/`infra`/`hardware`/`data`/`config`/…), '
    + 'plus `owner-*`, `status-*`, `app-*`. Genuine non-components (PoCs, demos, dev tooling) '
    + 'should be archived or tagged `arch-map-ignore`.', '')
  for (const c of uncurated.sort((a, b) => a.name.localeCompare(b.name))) lines.push(`- [ ] \`${c.name}\``)
  lines.push('')
}

if (!incomplete.length && !uncurated.length) lines.push('🎉 Every active repo is fully curated. Nothing to do.', '')

process.stdout.write(lines.join('\n'))
