// Component Inventory, built from GitHub repo metadata. Per component it merges:
//   github-meta.json      (github-inventory.mjs) descriptions and type-/status-/owner-/app- topics
//   inventory-extra.json  what can't live on a repo: contact, dates, comments, display-name
//                         overrides, components without a repo (third-party services), and
//                         fallback fields for repos whose topics couldn't be written yet.
// Topics win over fallbacks, so curating a repo on GitHub immediately updates the map.
import fs from 'node:fs'
import path from 'node:path'
import { AUDIT } from './_paths.mjs'

const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const appConfig = readJson(path.join(AUDIT, 'config.json'), {})

const GH_META = path.join(AUDIT, 'github-meta.json')
const EXTRA = path.join(AUDIT, 'inventory-extra.json')
const INTEGRATIONS_CSV = path.join(AUDIT, 'integrations.csv')
const THIRDPARTY_CSV = path.join(AUDIT, 'third-party-meta.csv')

// ---- Topic schema (display name -> slug; the reverse is derived) -----------------------
export const TOPIC_MAPS = {
  type: {
    Client: 'type-client',
    Service: 'type-service',
    'Third-Party Service': 'type-third-party-service',
    Library: 'type-library',
    Assets: 'type-assets',
    Tests: 'type-tests',
    Firmware: 'type-firmware',
    Infrastructure: 'type-infra',
    Hardware: 'type-hardware',
    Data: 'type-data',
    Config: 'type-config',
  },
  status: {
    Current: 'status-current',
    Planned: 'status-planned',
    Sunsetting: 'status-sunsetting',
    Removed: 'status-removed',
  },
  // Optional refinement of type, closed per parent type (SUBTYPE_PARENTS below). Unset means the
  // plain type.
  subtype: {
    API: 'subtype-api',
    Worker: 'subtype-worker',
    Connector: 'subtype-connector',
    Gateway: 'subtype-gateway',
    Framework: 'subtype-framework',
    UI: 'subtype-ui',
    Model: 'subtype-model',
  },
  // Teams and applications come from config.json (`owners`, `applications`). Both are open: any
  // owner-*/app-* topic is accepted and title-cased ('app-fleet-ops' -> 'Fleet Ops'). Name an entry
  // when that title is wrong, or when it must match the viz label maps and inventory-extra's
  // repo-less entries exactly; otherwise one application splits into two Matrix columns.
  owner: { ...appConfig.owners },
  app: { ...appConfig.applications },
}
// The parent type each subtype refines. guard-data errors on a mismatch (subtype-worker on a
// Library) just like on an unknown closed-enum value.
export const SUBTYPE_PARENTS = {
  API: ['Service'],
  Worker: ['Service'],
  Connector: ['Service'],
  Gateway: ['Service'],
  Framework: ['Library'],
  UI: ['Library'],
  Model: ['Library'],
}

const invertMap = (map) => Object.fromEntries(Object.entries(map).map(([key, value]) => [value, key]))
const NAME_BY_SLUG = Object.fromEntries(
  Object.entries(TOPIC_MAPS).map(([dimension, map]) => [dimension, invertMap(map)]),
)

const CLUSTER_PREFIX = 'cluster-'
const OWNER_PREFIX = 'owner-'

// 'fleet-ops' -> 'Fleet Ops'
const titleCase = (slug) =>
  slug
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')

// Readable fallback for an unknown slug: 'app-fleet-ops' -> 'Fleet Ops'
const slugToTitle = (slug) => titleCase(slug.replace(/^(subtype|app|type|status|owner)-/, ''))

// `cluster-*` overrides a component's cluster on the map regardless of its owning team, for
// cross-cutting libraries (e.g. cluster-shared). Slugs map back to the config.json `clusters`
// labels, so irregular casing ('IoT') survives a lowercase topic; anything else title-cases, so a
// new cluster works before it's configured.
const CLUSTER_NAMES = Object.fromEntries(
  (Array.isArray(appConfig.clusters) ? appConfig.clusters : [])
    .filter((cluster) => cluster?.label)
    .map((cluster) => [cluster.label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), cluster.label]),
)

const clusterName = (topic) => {
  const slug = topic.slice(CLUSTER_PREFIX.length)
  return CLUSTER_NAMES[slug] || titleCase(slug)
}

// 'owner-new-team' -> 'NEW.TEAM'
const unknownOwnerName = (topic) => topic.slice(OWNER_PREFIX.length).toUpperCase().replace(/-/g, '.')

export const parseTopics = (topics = []) => {
  const parsed = { type: null, subtype: null, status: null, owner: null, applications: [], cluster: null }
  for (const topic of topics) {
    if (NAME_BY_SLUG.type[topic]) parsed.type = NAME_BY_SLUG.type[topic]
    else if (NAME_BY_SLUG.subtype[topic]) parsed.subtype = NAME_BY_SLUG.subtype[topic]
    else if (NAME_BY_SLUG.status[topic]) parsed.status = NAME_BY_SLUG.status[topic]
    else if (NAME_BY_SLUG.owner[topic]) parsed.owner = NAME_BY_SLUG.owner[topic]
    else if (topic.startsWith('app-')) parsed.applications.push(NAME_BY_SLUG.app[topic] || slugToTitle(topic))
    else if (topic.startsWith(CLUSTER_PREFIX)) parsed.cluster = clusterName(topic)
    else if (topic.startsWith(OWNER_PREFIX)) parsed.owner = unknownOwnerName(topic)
    // Unknown subtype/type/status slugs still parse (title-cased) so the guard rejects the typo:
    // a closed enum must fail loudly, not no-op.
    else if (topic.startsWith('subtype-')) parsed.subtype = slugToTitle(topic)
    else if (topic.startsWith('type-')) parsed.type = slugToTitle(topic)
    else if (topic.startsWith('status-')) parsed.status = slugToTitle(topic)
  }
  return parsed
}

const hasInventoryTopics = (parsed) =>
  parsed.type || parsed.status || parsed.owner || parsed.applications.length || parsed.cluster

// Topics win over inventory-extra fallbacks; org custom properties (technical-contact,
// abbreviation, doc-url, doc-label) win over curated extras.
function repoComponent(repoName, repo, repoExtra, topics) {
  const fallback = repoExtra?.fallback || {}
  const properties = repo.props || {}
  return {
    name: repoExtra?.name || repoName,
    abbr: properties.abbreviation || repoExtra?.abbr || '',
    type: topics.type || fallback.type || '',
    // A curated subtype covers monorepo-renamed entries whose repo topic can't speak for them
    // (device-data-service -> device-data-ingestion).
    subtype: topics.subtype || repoExtra?.subtype || fallback.subtype || '',
    status: topics.status || fallback.status || '',
    owner: topics.owner || fallback.owner || '',
    // A curated cluster is a correction, so it beats the topic (e.g. KB components are
    // CSS-shared, not suite-wide Shared).
    cluster: repoExtra?.cluster || topics.cluster || fallback.cluster || '',
    applications: topics.applications.length ? topics.applications : fallback.applications || [],
    description: repo.description || fallback.description || '',
    contact: properties['technical-contact'] || repoExtra?.contact || '',
    introDate: repoExtra?.introDate || '',
    sunsetDate: repoExtra?.sunsetDate || '',
    comment: repoExtra?.comment || '',
    doc: properties['doc-label'] || repoExtra?.doc || '',
    docUrl: properties['doc-url'] || repoExtra?.docUrl || '',
    repo: repo.url,
    repoName,
    // Archived repos are read-only, so their topics can't be re-curated; assemble.mjs flags a
    // status topic that still reads live.
    ...(repo.archived ? { archived: true } : {}),
    ...(repo.health ? { health: repo.health } : {}),
    ...(repo.pushedAt ? { pushedAt: repo.pushedAt } : {}),
    ...(repo.createdAt ? { createdAt: repo.createdAt } : {}),
  }
}

// Curated records are sparse: empty fields are omitted in the file and defaulted here.
function nonRepoComponent(record) {
  // Fail loudly: a nameless entry would crash later with an opaque TypeError.
  if (!record.name) {
    const preview = JSON.stringify(record).slice(0, 120)
    throw new Error(`inventory-extra.json nonRepo entry without a name: ${preview}`)
  }
  return {
    abbr: '',
    type: '',
    subtype: '',
    status: '',
    owner: '',
    cluster: '',
    applications: [],
    description: '',
    contact: '',
    introDate: '',
    sunsetDate: '',
    comment: '',
    doc: '',
    docUrl: '',
    repo: null,
    repoName: null,
    ...record,
  }
}

function indexInventory(inventory) {
  const byRepo = {}
  const byName = {}
  for (const component of inventory) {
    if (component.repoName) {
      if (!byRepo[component.repoName]) byRepo[component.repoName] = []
      byRepo[component.repoName].push(component)
    }
    const key = component.name.toLowerCase()
    if (byName[key]) {
      console.warn(`inventory: duplicate component name "${component.name}" — the later entry wins in byName`)
    }
    byName[key] = component
  }
  return { byRepo, byName }
}

// Archived repos and repos tagged `arch-map-ignore` are deliberately not components; assemble
// keeps them out of the uncurated-repos backlog so PoCs and demos don't nag forever.
const isIgnoredRepo = (repo) => repo.archived || (repo.topics || []).includes('arch-map-ignore')

export function loadInventory() {
  const meta = readJson(GH_META)
  const extra = readJson(EXTRA) || { repoExtras: {}, nonRepo: [] }
  const inventory = []

  for (const [repoName, repo] of Object.entries(meta?.repos || {})) {
    const repoExtra = extra.repoExtras?.[repoName]
    const topics = parseTopics(repo.topics)
    // Membership needs a topic or a curated extra. Custom properties alone (doc-url etc.) must not
    // put a repo on the map as a default-kind service.
    if (!hasInventoryTopics(topics) && !repoExtra) continue
    inventory.push(repoComponent(repoName, repo, repoExtra, topics))
  }
  for (const record of extra.nonRepo || []) inventory.push(nonRepoComponent(record))

  const { byRepo, byName } = indexInventory(inventory)
  const ignored = new Set(
    Object.entries(meta?.repos || {})
      .filter(([, repo]) => isIgnoredRepo(repo))
      .map(([name]) => name),
  )
  return { inventory, byRepo, byName, ignored }
}

// RFC-4180: quoted fields, embedded commas/newlines and "" escapes. Blank rows are dropped.
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    if (row.some((value) => value !== '')) rows.push(row)
    row = []
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inQuotes) {
      if (char !== '"') {
        field += char
      } else if (text[index + 1] === '"') {
        field += '"'
        index++
      } else {
        inQuotes = false
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      endField()
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      endRow()
    } else {
      field += char
    }
  }
  if (field !== '' || row.length) endRow()
  return rows
}

// A CSV file as header-keyed objects.
function readCsvObjects(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const [header, ...rows] = parseCsv(raw)
  if (!header) return []
  return rows.map((row) =>
    Object.fromEntries(header.map((column, index) => [column, (row[index] || '').trim()])),
  )
}

// Service-to-service integrations (integrations.csv). Rows still flagged "… — VERIFY" were seeded
// from a repo description, not confirmed from code, so they render as inferred.
export function loadIntegrations() {
  return readCsvObjects(INTEGRATIONS_CSV)
    .filter((row) => row.Source && row.Target)
    .map((row) => ({
      source: row.Source,
      target: row.Target,
      protocol: row.Protocol || 'REST',
      channel: row.Channel || '',
      note: row.Note || '',
      verified: !/verify/i.test(row.Note || ''),
    }))
}

// Third-party service metadata (third-party-meta.csv), keyed by lowercased component name.
export function loadThirdPartyMeta() {
  const metaByName = {}
  for (const row of readCsvObjects(THIRDPARTY_CSV)) {
    if (!row.Name) continue
    metaByName[row.Name.toLowerCase()] = {
      vendor: row.Vendor || '',
      url: row.URL || '',
      auth: row.Auth || '',
      dataClassification: row.DataClassification || '',
      criticality: row.Criticality || '',
      contractOwner: row.ContractOwner || '',
      environments: row.Environments || '',
      notes: row.Notes || '',
      // Optional, space-separated API hosts, for when they differ from the vendor homepage
      // (googleapis.com, hana.ondemand.com): assemble.mjs matches outbound URL hosts against them.
      hosts: (row.Hosts || '').split(/\s+/).filter(Boolean),
    }
  }
  return metaByName
}
