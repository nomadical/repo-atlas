// One run's rows, shared by the backfill (git log replay) and the per-run append —
// the two must not diverge on what a row is.
export const TYPE = {
  service: 'Service',
  client: 'Client',
  library: 'Library',
  tests: 'Tests',
  data: 'Data',
  firmware: 'Firmware',
  hardware: 'Hardware',
  infra: 'Infrastructure',
  assets: 'Assets',
  'third-party-service': 'Third-Party Service',
  config: 'Config',
}

// The value of the first topic carrying `prefix`, without the prefix; '' when there is none.
export const topic = (topics, prefix) =>
  (topics.find((candidate) => candidate.startsWith(prefix)) || '').slice(prefix.length)
export const cap = (text) => (text ? text[0].toUpperCase() + text.slice(1) : '')
// An unknown-but-present type-* topic keeps its (capitalised) slug rather than lying "Unclassified".
export const typeOf = (topics) =>
  TYPE[topic(topics, 'type-')] || cap(topic(topics, 'type-')) || 'Unclassified'
// Strips range operators from a manifest version: '^18.2' -> '18.2'.
export const ver = (version) => (version ? String(version).replace(/^[\^~>=<\s]+/, '') : version)

const APP_TOPIC = 'app-'

// '' when the topic is missing, like the other topic-derived fields.
const ownerFromTopics = (topics) => topic(topics, 'owner-').toUpperCase().split('-').join('.')

function languageOf(backend, toolingVersions) {
  if (backend) return backend.java
  if (toolingVersions.typescript) return `TypeScript ${ver(toolingVersions.typescript)}`
  if (toolingVersions.react) return 'JavaScript'
  return null
}

function frameworkOf(backend, toolingVersions) {
  if (backend) return backend.framework
  if (toolingVersions.react) return `React ${ver(toolingVersions.react)}`
  return null
}

// null = "scanned, has none"; missing key = "could not tell" — the page counts them differently.
function addScannedFacts(row, backend) {
  if (!backend) return
  if ('db' in backend) row.database = backend.db
  if ('log' in backend) row.logging = backend.log
  if ('trace' in backend) row.tracing = backend.trace
}

// Array.isArray on every list: a malformed file must not crash the night, and a string here
// would substring-match via String#includes and fake plausible verdicts.
const listIncludes = (list, name) => Array.isArray(list) && list.includes(name)

// The "not found" values must not contain the platform names, or conforms() reads them as passing.
function addRuntimeFacts(row, runtime, name) {
  if (!listIncludes(runtime?.checked, name)) return
  const logPlatform = runtime.loggingPlatform || 'Logs received'
  const tracePlatform = runtime.tracingPlatform || 'Traces received'
  row.logging = listIncludes(runtime.logs, name) ? logPlatform : 'No logs found'
  row.tracing = listIncludes(runtime.traces, name) ? tracePlatform : 'No traces found'
}

// Scan output is keyed by checkout folder, which can lag a GitHub rename — re-key on the
// remote name so a renamed repository doesn't read as "never scanned".
function backendsByRepoName(scanned) {
  const byName = {}
  for (const [folder, scan] of Object.entries(scanned)) byName[scan.repoName || folder] = scan
  return byName
}

function rowOf(name, repoMeta, { inventoryEntry, frontend, backend, runtime }) {
  const topics = repoMeta.topics || []
  const toolingVersions = frontend?.toolingVersions || {}
  const row = {
    repository: name,
    type: typeOf(topics),
    owner: inventoryEntry?.owner || ownerFromTopics(topics),
    applications:
      inventoryEntry?.applications ||
      topics.filter((t) => t.startsWith(APP_TOPIC)).map((t) => t.slice(APP_TOPIC.length)),
    status: inventoryEntry?.status || cap(topic(topics, 'status-')),
    language: languageOf(backend, toolingVersions),
    framework: frameworkOf(backend, toolingVersions),
    buildTool: backend ? backend.buildTool : null,
  }
  addScannedFacts(row, backend)
  addRuntimeFacts(row, runtime, name)
  if (repoMeta.archived) row.archived = true
  if (topics.includes('arch-map-ignore')) row.archMapIgnore = true
  if (inventoryEntry?.contact) row.contact = inventoryEntry.contact
  if (inventoryEntry && inventoryEntry.name !== name) row.inventoryName = inventoryEntry.name
  return row
}

// meta/fe/be: parsed github-meta.json, fe-architecture.json, backend-tooling.json for one night.
//
// runtime (optional): runtime-facts.json — what your observability platform actually received, as
// three repo lists (checked / logs / traces) plus the platform names to credit. A repo can't prove
// this about itself (it logs JSON to stdout and a cluster collector forwards it), so measured facts
// beat the repo scan for the repos in `checked`; repos outside it keep their scanned values.
// Write it from whatever your platform's API is — see docs/goldenpath/spec.md for the shape.
export function rowsFrom({ meta, fe, be, runtime }) {
  if (!meta?.repos) return null
  const frontendArchitecture = fe || {}
  const frontendByFolder = Object.fromEntries(
    (frontendArchitecture.repos || []).map((repo) => [repo.folder, repo]),
  )
  const inventoryByRepo = Object.fromEntries(
    (frontendArchitecture.inventory || [])
      .filter((entry) => entry.repoName)
      .map((entry) => [entry.repoName, entry]),
  )
  const backendByRepo = backendsByRepoName(be?.scanned || {})

  const rows = {}
  for (const [name, repoMeta] of Object.entries(meta.repos)) {
    rows[name] = rowOf(name, repoMeta, {
      inventoryEntry: inventoryByRepo[name],
      frontend: frontendByFolder[name],
      backend: backendByRepo[name],
      runtime,
    })
  }
  return rows
}
