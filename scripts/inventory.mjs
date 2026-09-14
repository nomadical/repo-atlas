// Component Inventory — built live from GitHub repo metadata instead of a hand-curated CSV.
//
// Sources, merged per component:
//   github-meta.json      (github-inventory.mjs) — descriptions + type-/status-/owner-/app- topics
//   inventory-extra.json  — what can't live on a repo: technical contact, dates, comments,
//                           review trail, display-name overrides, components WITHOUT a repo
//                           (third-party services), and fallback fields for repos whose
//                           topics couldn't be written yet.
// Topics win over fallbacks, so curating a repo on GitHub immediately updates the map.
import fs from 'node:fs'
import path from 'node:path'
import { AUDIT } from './_paths.mjs'

const readJsonAt = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} } }
const appConfig = readJsonAt(path.join(AUDIT, 'config.json'))

const GH_META = path.join(AUDIT, 'github-meta.json')
const EXTRA = path.join(AUDIT, 'inventory-extra.json')
const INTEGRATIONS_CSV = path.join(AUDIT, 'integrations.csv')
const THIRDPARTY_CSV = path.join(AUDIT, 'third-party-meta.csv')

// ---- topic schema (forward maps; reverse derived) ------------------------------------
export const TOPIC_MAPS = {
  type: {
    'Client': 'type-client', 'Service': 'type-service', 'Third-Party Service': 'type-third-party-service',
    'Library': 'type-library', 'Assets': 'type-assets', 'Tests': 'type-tests',
    'Firmware': 'type-firmware', 'Infrastructure': 'type-infra', 'Hardware': 'type-hardware',
    'Data': 'type-data', 'Config': 'type-config',
  },
  status: { 'Current': 'status-current', 'Planned': 'status-planned', 'Sunsetting': 'status-sunsetting', 'Removed': 'status-removed' },
  // Optional refinement of type — closed per PARENT type (SUBTYPE_PARENTS below): Service splits
  // into request/response APIs, background workers, integration connectors and edge gateways;
  // Library into build-on-me frameworks, UI kits and shared models. Unset = the plain type.
  subtype: {
    'API': 'subtype-api', 'Worker': 'subtype-worker', 'Connector': 'subtype-connector', 'Gateway': 'subtype-gateway',
    'Framework': 'subtype-framework', 'UI': 'subtype-ui', 'Model': 'subtype-model',
  },
  // Teams and applications are YOUR vocabulary, so they live in config.json rather than here:
  // `owners` and `applications`, each a { 'Display Name': 'slug' } map. Both are OPEN — leave them
  // empty and any owner-*/app-* topic is accepted, with the slug title-cased for display
  // ('app-fleet-ops' → 'Fleet Ops'). Name an entry only when the automatic title is wrong (an
  // acronym, punctuation, irregular casing) or when the display name must match exactly what the
  // viz label maps and inventory-extra.json's repo-less entries use — otherwise one application
  // splits into two columns in the Matrix and loses its tag chip.
  owner: { ...(appConfig.owners || {}) },
  app: { ...(appConfig.applications || {}) },
}
// Which parent type each subtype refines — guard-data errors on a mismatched pair
// (e.g. subtype-worker on a Library) just like an unknown closed-enum value.
export const SUBTYPE_PARENTS = {
  'API': ['Service'], 'Worker': ['Service'], 'Connector': ['Service'], 'Gateway': ['Service'],
  'Framework': ['Library'], 'UI': ['Library'], 'Model': ['Library'],
}

const reverse = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]))
const REV = Object.fromEntries(Object.entries(TOPIC_MAPS).map(([k, m]) => [k, reverse(m)]))
// unknown slug -> readable fallback ('app-fleet-ops' -> 'Fleet Ops')
const slugToTitle = (slug) => slug.replace(/^(subtype|app|type|status|owner)-/, '').split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')

// `cluster-*` overrides which cluster a component sits in on the map, regardless of its owning
// team — for cross-cutting libraries (e.g. cluster-shared) that serve the whole suite.
// Slugs resolve back to the labels declared in config.json `clusters`, so a cluster whose label has
// irregular casing ('IoT') survives the round-trip through a lowercase topic; anything unrecognised
// title-cases ('cluster-frontend' → 'Frontend'), so a new cluster works before it's configured.
const CLUSTER_NAMES = Object.fromEntries(
  (Array.isArray(appConfig.clusters) ? appConfig.clusters : [])
    .filter((c) => c?.label)
    .map((c) => [c.label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), c.label]),
)

export const parseTopics = (topics = []) => {
  const out = { type: null, subtype: null, status: null, owner: null, applications: [], cluster: null }
  for (const t of topics) {
    if (REV.type[t]) out.type = REV.type[t]
    else if (REV.subtype[t]) out.subtype = REV.subtype[t]
    else if (REV.status[t]) out.status = REV.status[t]
    else if (REV.owner[t]) out.owner = REV.owner[t]
    else if (t.startsWith('app-')) out.applications.push(REV.app[t] || slugToTitle(t))
    else if (t.startsWith('cluster-')) out.cluster = CLUSTER_NAMES[t.slice(8)] || t.slice(8).split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
    else if (t.startsWith('owner-')) out.owner = t.slice(6).toUpperCase().replace(/-/g, '.')
    // unknown subtype slugs are still parsed (title-cased) so the guard can reject the typo,
    // exactly like unknown type-/status- slugs below — a closed enum must fail loudly, not no-op
    else if (t.startsWith('subtype-')) out.subtype = slugToTitle(t)
    else if (t.startsWith('type-')) out.type = slugToTitle(t)
    else if (t.startsWith('status-')) out.status = slugToTitle(t)
  }
  return out
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

export function loadInventory() {
  const meta = readJson(GH_META)
  const extra = readJson(EXTRA) || { repoExtras: {}, nonRepo: [] }
  const inventory = []

  for (const [repoName, r] of Object.entries(meta?.repos || {})) {
    const ex = extra.repoExtras?.[repoName]
    const t = parseTopics(r.topics)
    const hasInvTopics = t.type || t.status || t.owner || t.applications.length || t.cluster
    // Inventory membership needs a topic or a curated extra — matching the documented rule ("a
    // type-* topic is the minimum"). Bare custom properties (doc-url etc.) must NOT draw a repo:
    // setting just a doc link would otherwise scaffold it onto the map as a default-kind service.
    if (!hasInvTopics && !ex) continue // not an inventory component
    const fb = ex?.fallback || {}
    const props = r.props || {} // org custom properties (technical-contact, abbreviation, doc-url, doc-label)
    inventory.push({
      name: ex?.name || repoName,
      abbr: props.abbreviation || ex?.abbr || '',
      type: t.type || fb.type || '',
      // topic wins; a curated repoExtras subtype covers monorepo-renamed entries whose repo
      // topic can't speak for them (device-data-service → device-data-ingestion)
      subtype: t.subtype || ex?.subtype || fb.subtype || '',
      status: t.status || fb.status || '',
      owner: t.owner || fb.owner || '',
      // an explicit `cluster` in inventory-extra is a curated correction and overrides the repo's
      // `cluster-*` topic (e.g. KB components are CSS-shared, not suite-wide Shared).
      cluster: ex?.cluster || t.cluster || fb.cluster || '',
      applications: t.applications.length ? t.applications : (fb.applications || []),
      description: r.description || fb.description || '',
      contact: props['technical-contact'] || ex?.contact || '', introDate: ex?.introDate || '', sunsetDate: ex?.sunsetDate || '',
      // Documentation link/label live on the repo as org custom properties (doc-url / doc-label),
      // so owners maintain them on GitHub like technical-contact/abbreviation. inventory-extra
      // stays a fallback for repos whose properties couldn't be written yet.
      comment: ex?.comment || '', doc: props['doc-label'] || ex?.doc || '', docUrl: props['doc-url'] || ex?.docUrl || '',
      repo: r.url, repoName,
      // archived on GitHub — read-only, so its topics can't be re-curated in place. Surfaced as a
      // status-mismatch curation gap when the status topic still reads live (assemble.mjs).
      ...(r.archived ? { archived: true } : {}),
      // live repo health from GitHub (github-inventory): Dependabot alerts + latest CI + last push
      ...(r.health ? { health: r.health } : {}),
      ...(r.pushedAt ? { pushedAt: r.pushedAt } : {}),
      ...(r.createdAt ? { createdAt: r.createdAt } : {}),
    })
  }
  // components without a repo (third-party services etc.) — curated in inventory-extra.json
  // (sparse records: empty fields are omitted in the file, defaulted here)
  for (const e of extra.nonRepo || []) {
    // fail loudly on a malformed curated record — a nameless entry would otherwise crash later
    // with an opaque TypeError, and a name duplicating an existing component would silently
    // last-win in the byName index below
    if (!e.name) throw new Error(`inventory-extra.json nonRepo entry without a name: ${JSON.stringify(e).slice(0, 120)}`)
    inventory.push({
      abbr: '', type: '', subtype: '', status: '', owner: '', cluster: '', applications: [], description: '', contact: '',
      introDate: '', sunsetDate: '', comment: '', doc: '', docUrl: '',
      repo: null, repoName: null, ...e,
    })
  }

  const byRepo = {}, byName = {}
  for (const e of inventory) {
    if (e.repoName) (byRepo[e.repoName] = byRepo[e.repoName] || []).push(e)
    const key = e.name.toLowerCase()
    if (byName[key]) console.warn(`inventory: duplicate component name "${e.name}" — the later entry wins in byName`)
    byName[key] = e
  }
  // Repos intentionally NOT architecture components: archived repos (read-only, can't be
  // topiced) and any repo tagged `arch-map-ignore`. assemble excludes these from the
  // uncurated-repos backlog so noise (PoCs, demos, dev-tooling) doesn't nag forever.
  const ignored = new Set(Object.entries(meta?.repos || {})
    .filter(([, r]) => r.archived || (r.topics || []).includes('arch-map-ignore'))
    .map(([name]) => name))
  return { inventory, byRepo, byName, ignored }
}

// RFC-4180 CSV parser: handles quoted fields, embedded commas/newlines, and "" escapes.
// (still used for integrations.csv and third-party-meta.csv)
export function parseCsv(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false }
      else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((x) => x !== '')) rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((x) => x !== '')) rows.push(row) }
  return rows
}

// Generic: parse a CSV file into an array of header-keyed objects.
function readCsvObjects(file) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch { return [] }
  const [header, ...rows] = parseCsv(raw)
  if (!header) return []
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])))
}

// Service-to-service integrations (integrations.csv): { source, target, protocol, channel, note,
// verified }. verified=false for rows still flagged "… — VERIFY" (seeded from a repo description,
// not confirmed from code) so the map can render them as inferred rather than fact.
export function loadIntegrations() {
  return readCsvObjects(INTEGRATIONS_CSV)
    .filter((r) => r.Source && r.Target)
    .map((r) => ({ source: r.Source, target: r.Target, protocol: r.Protocol || 'REST', channel: r.Channel || '', note: r.Note || '', verified: !/verify/i.test(r.Note || '') }))
}

// Third-party service metadata (third-party-meta.csv), keyed by component name.
export function loadThirdPartyMeta() {
  const out = {}
  for (const r of readCsvObjects(THIRDPARTY_CSV)) {
    if (!r.Name) continue
    out[r.Name.toLowerCase()] = {
      vendor: r.Vendor || '', url: r.URL || '', auth: r.Auth || '', dataClassification: r.DataClassification || '',
      criticality: r.Criticality || '', contractOwner: r.ContractOwner || '', environments: r.Environments || '', notes: r.Notes || '',
      // API host(s)/domain(s) this service is reached at, space-separated — lets the code-derived REST
      // matcher (assemble.mjs) map an outbound URL host to this component when it differs from the
      // vendor homepage domain (e.g. googleapis.com, hana.ondemand.com). Optional.
      hosts: (r.Hosts || '').split(/\s+/).filter(Boolean),
    }
  }
  return out
}
