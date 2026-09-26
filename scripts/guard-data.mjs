// Safety net for automated regeneration: rejects a freshly generated fe-architecture.json that
// regressed in a way that would silently corrupt the diagram. Exits non-zero so CI skips the
// commit and the last good data stays published.
//
//   Coverage   core repos present and counts not collapsed (e.g. a clone failed in CI)
//   Integrity  every link source and design-system consumer resolves to a real node
//   Schema     type/status/subtype are known values, catching typo'd topics (`status-currnet`)
// Coverage, integrity and closed-enum failures are errors; the open owner field only warns.
//
// validate() is pure (data -> { errors, warnings, count }) so it can be unit-tested.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUDIT } from './_paths.mjs'
import { TOPIC_MAPS, SUBTYPE_PARENTS } from './inventory.mjs'

// Coverage tripwires, from config.json `guard`. They stop a half-failed regenerate run from
// committing a map with half the estate missing: set them to today's real counts minus ~20%. Unset
// they're inert, so a fresh fork isn't blocked, but it isn't protected either.
//
//   coreRepos    folders that must always be present. They are cloned, not topic-derived, so
//                they survive a token losing topic scope: pick the ones whose absence means a
//                broken clone.
//   minRepos     floor on scanned repos, catching a clone step that failed wholesale.
//   minInventory floor on the Component Inventory. A token losing topic scope strips dozens of
//                components while every core repo survives, which minRepos can't see.
function readGuardConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(AUDIT, 'config.json'), 'utf8')).guard || {}
  } catch {
    return {}
  }
}

const guardConfig = readGuardConfig()
export const CORE = Array.isArray(guardConfig.coreRepos) ? guardConfig.coreRepos : []
export const MIN_REPOS = Number.isFinite(guardConfig.minRepos) ? guardConfig.minRepos : 0
export const MIN_INVENTORY = Number.isFinite(guardConfig.minInventory) ? guardConfig.minInventory : 0

const MS_PER_HOUR = 3600000
const KAFKA_BUS = 'Kafka'
const CURATION_FIELDS = ['owner', 'status', 'description']
const ENV_INFIX = /\.(dev|test|pre|prod|demo|poc|nonprod|sandbox|e2e)(?=\.)/g

// Requested with GUARD_MAX_AGE_HOURS after a regenerate. The pipeline tolerates individual script failures, so a
// failed gather can leave a stale fe-architecture.json next to refreshed sibling files.
function checkFreshness(data, maxAgeHours, errors) {
  if (!(maxAgeHours > 0)) return
  const ageMs = Date.now() - new Date(data.generatedAt || 0).getTime()
  if (!data.generatedAt || Number.isNaN(ageMs)) {
    errors.push('generatedAt is missing/unparsable (freshness check requested)')
  } else if (ageMs > maxAgeHours * MS_PER_HOUR) {
    errors.push(
      `generatedAt is ${Math.round(ageMs / MS_PER_HOUR)}h old (max ${maxAgeHours}h) — the pipeline did not regenerate fe-architecture.json this run`,
    )
  }
}

// Mirrors the required fields of schema/fe-architecture.schema.json. The ajv schema test enforces
// the full contract in CI; this covers the data-refresh path.
const arrayOrEmpty = (value) => (Array.isArray(value) ? value : [])

function checkShape(data, errors) {
  if (!Array.isArray(data.repos)) errors.push('repos is not an array')
  if (!Array.isArray(data.inventory)) errors.push('inventory is not an array')
  if (arrayOrEmpty(data.repos).some((repo) => typeof repo.folder !== 'string' || !repo.folder)) {
    errors.push('a repo is missing its folder')
  }
  if (
    arrayOrEmpty(data.inventory).some((component) => typeof component.name !== 'string' || !component.name)
  ) {
    errors.push('an inventory component is missing its name')
  }
}

function checkCoverage(data, repoFolders, errors) {
  const repoCount = data.repos.length
  const missingCore = CORE.filter((folder) => !repoFolders.has(folder))
  if (missingCore.length) errors.push(`missing core repos: ${missingCore.join(', ')}`)
  if (repoCount < MIN_REPOS) errors.push(`only ${repoCount} repos (min ${MIN_REPOS})`)
  const inventoryCount = data.inventory.length
  if (inventoryCount < MIN_INVENTORY) {
    errors.push(
      `only ${inventoryCount} inventory components (min ${MIN_INVENTORY}) — topics stripped / github-inventory failed?`,
    )
  }
  // integrations.csv always has curated rows and assemble derives more, so empty means a lost input.
  if (!(data.integrations || []).length) {
    errors.push(
      'integrations is empty — integrations.csv unread or the service-link derivation lost its inputs',
    )
  }
}

// What the graph can draw: repos by folder, inventory components by name (which covers repo-less
// third-party services), backend nodes by id/repo/label/alias (as graph.js beIdByKey), and the
// shared Kafka bus. External targets (SaaS backends) are not nodes, so only link sources are checked.
function nodeLookup(data, repoFolders) {
  const inventoryNames = new Set(data.inventory.map((component) => component.name))
  const backendKeys = new Set(
    (data.backendTopology?.backends || []).flatMap((backend) =>
      [backend.id, backend.repo, backend.label, backend.invAlias].filter(Boolean),
    ),
  )
  return (id) => id === KAFKA_BUS || repoFolders.has(id) || inventoryNames.has(id) || backendKeys.has(id)
}

// A non-null serviceRepo names the repo that owns a service. It must be a drawn folder or a repo
// some inventory component references (the owner may not be cloned this run). Entries without
// serviceRepo predate the field and are skipped.
function checkServiceRepos(data, repoFolders, errors) {
  const knownRepos = new Set([
    ...repoFolders,
    ...data.inventory.map((component) => component.repoName).filter(Boolean),
  ])
  for (const entry of [...data.repos, ...data.inventory]) {
    if (entry.serviceRepo == null || knownRepos.has(entry.serviceRepo)) continue
    errors.push(
      `serviceRepo "${entry.serviceRepo}" (of service "${entry.serviceId || entry.name || entry.folder}") is not a known repo`,
    )
  }
}

function checkIntegrity(data, repoFolders, errors, warnings) {
  const isNode = nodeLookup(data, repoFolders)
  for (const link of data.integrations || []) {
    if (!isNode(link.source)) errors.push(`service link source "${link.source}" is not a known node`)
  }
  for (const consumer of data.uiConsumers || []) {
    if (!repoFolders.has(consumer.repo)) {
      errors.push(`design-system consumer "${consumer.repo}" is not a present repo`)
    }
  }
  // Dangling curated topology (backend-extra.json) only loses an edge or card, so warn.
  for (const edge of data.backendTopology?.serviceEdges || []) {
    for (const end of [edge.source, edge.target]) {
      if (end && !isNode(end)) warnings.push(`serviceEdges: "${end}" is not a known node (edge won't draw)`)
    }
  }
  for (const contentRepo of data.backendTopology?.contentRepos || []) {
    if (contentRepo.parent && !isNode(contentRepo.parent)) {
      warnings.push(`contentRepos: parent "${contentRepo.parent}" is not a known node (card won't draw)`)
    }
  }
  checkServiceRepos(data, repoFolders, errors)
}

const normalizeHost = (host) =>
  String(host || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(ENV_INFIX, '.{env}')
    .toLowerCase()

// The client drill-down resolves endpoints to a backend by host, so an apiUrl host with no backend
// node dead-ends the trace.
function checkBackendHosts(data, warnings) {
  const backendHosts = new Set(
    (data.backendTopology?.backends || [])
      .filter((backend) => backend.host)
      .map((backend) => normalizeHost(backend.host)),
  )
  if (!backendHosts.size) return
  for (const repo of data.repos) {
    if (!repo.apiUrl || backendHosts.has(normalizeHost(repo.apiUrl))) continue
    warnings.push(
      `"${repo.folder}": apiUrl host "${repo.apiUrl}" has no backend node (FE→backend trace dead-ends; add it to backend-extra.json)`,
    )
  }
}

// Subtype is a closed enum and must also suit its parent type.
function checkSubtype(component, knownSubtypes, errors) {
  if (!component.subtype) return
  if (!knownSubtypes.has(component.subtype)) {
    errors.push(`"${component.name}": unknown subtype "${component.subtype}" (bad subtype-* topic?)`)
    return
  }
  const allowedTypes = SUBTYPE_PARENTS[component.subtype] || []
  if (component.type && !allowedTypes.includes(component.type)) {
    errors.push(
      `"${component.name}": subtype "${component.subtype}" is not valid for type "${component.type}" (allowed on: ${allowedTypes.join(', ')})`,
    )
  }
}

// Half-curated components still render, and the per-component detail lives in
// validation.incompleteCuration and the weekly curation report, so they get one summary line
// instead of 70+ that would bury the real warnings.
function summarizeHalfCurated(halfCurated) {
  const missingCountByField = Object.fromEntries(CURATION_FIELDS.map((field) => [field, 0]))
  for (const { missing } of halfCurated) {
    for (const field of missing) missingCountByField[field]++
  }
  const breakdown = Object.entries(missingCountByField)
    .filter(([, count]) => count)
    .map(([field, count]) => `${count} missing ${field}`)
    .join(', ')
  return `${halfCurated.length} components half-curated (${breakdown}) — see the weekly curation report / validation.incompleteCuration`
}

// Type and status are closed enums (errors); owner is an open set (warnings).
function checkTopicSchema(data, errors, warnings) {
  const knownTypes = new Set(Object.keys(TOPIC_MAPS.type))
  const knownStatuses = new Set(Object.keys(TOPIC_MAPS.status))
  const knownOwners = new Set(Object.keys(TOPIC_MAPS.owner))
  const knownSubtypes = new Set(Object.keys(TOPIC_MAPS.subtype || {}))
  const halfCurated = [] // repo-backed components with a type but missing a curation field
  for (const component of data.inventory) {
    if (component.type && !knownTypes.has(component.type)) {
      errors.push(`"${component.name}": unknown type "${component.type}" (bad type-* topic?)`)
    }
    checkSubtype(component, knownSubtypes, errors)
    if (component.status && !knownStatuses.has(component.status)) {
      errors.push(`"${component.name}": unknown status "${component.status}" (bad status-* topic?)`)
    }
    // With no `owners` in config.json there is no vocabulary to be off-schema against.
    if (knownOwners.size && component.owner && !knownOwners.has(component.owner)) {
      warnings.push(`"${component.name}": owner "${component.owner}" not in the documented schema`)
    }
    if (component.repoName && component.type) {
      const missing = CURATION_FIELDS.filter((field) => !component[field])
      if (missing.length) halfCurated.push({ name: component.name, missing })
    }
  }
  if (halfCurated.length) warnings.push(summarizeHalfCurated(halfCurated))
}

// Screen data is heuristic, so this never blocks. The signal is a collapse in coverage (the
// router parser broke everywhere), not the few clients that legitimately have no routes.
function checkScreens(data, extras, repoFolders, warnings) {
  const perRepo = extras?.screens?.perRepo
  if (!perRepo) return
  for (const folder of Object.keys(perRepo)) {
    if (!repoFolders.has(folder)) warnings.push(`screens: "${folder}" is not a present repo`)
  }
  const clients = data.repos.filter((repo) => repo.kind === 'client').map((repo) => repo.folder)
  const withScreens = clients.filter((folder) => perRepo[folder]?.screens?.length)
  if (clients.length && withScreens.length < Math.ceil(clients.length / 2)) {
    warnings.push(
      `screens: only ${withScreens.length}/${clients.length} client repos produced screens (router parser regression?)`,
    )
  }
}

// opts.maxAgeHours: when set, data.generatedAt must be within that window. A plain `npm run guard`
// on days-old committed data stays valid, so there is no default.
export function validate(rawData, extras = null, opts = {}) {
  const errors = []
  const warnings = []
  checkFreshness(rawData, opts.maxAgeHours, errors)
  checkShape(rawData, errors)

  // The other checks assume lists, so a malformed one is emptied once checkShape has reported it.
  const data = { ...rawData, repos: arrayOrEmpty(rawData.repos), inventory: arrayOrEmpty(rawData.inventory) }
  const repoFolders = new Set(data.repos.map((repo) => repo.folder))
  checkCoverage(data, repoFolders, errors)
  checkIntegrity(data, repoFolders, errors, warnings)
  checkBackendHosts(data, warnings)
  checkTopicSchema(data, errors, warnings)
  checkScreens(data, extras, repoFolders, warnings)

  return { errors, warnings, count: data.repos.length }
}

// ---- CLI -------------------------------------------------------------------------------------

function readExtras() {
  try {
    return JSON.parse(fs.readFileSync(path.join(AUDIT, 'fe-architecture-extras.json'), 'utf8'))
  } catch {
    return null
  }
}

function main() {
  const data = JSON.parse(fs.readFileSync(path.join(AUDIT, 'fe-architecture.json'), 'utf8'))
  const maxAgeHours = Number(process.env.GUARD_MAX_AGE_HOURS)
  const { errors, warnings, count } = validate(data, readExtras(), maxAgeHours > 0 ? { maxAgeHours } : {})
  for (const warning of warnings) console.warn(`⚠ ${warning}`)
  if (errors.length) {
    console.error(`✗ data guard FAILED — not committing. ${count} repos.`)
    for (const error of errors) console.error(`  • ${error}`)
    process.exit(1)
  }
  const warningNote = warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''
  console.log(
    `✓ data guard passed — ${count} repos, all ${CORE.length} core present, edges + topic schema valid` +
      warningNote,
  )
}

// Run only when invoked directly, not when imported by a test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
