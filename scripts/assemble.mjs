import fs from 'node:fs'
import path from 'node:path'

import { ROOT, AUDIT, ORG, inOrg } from './_paths.mjs'
import { uncloned, OUTSIDE, remoteOf } from './repos.mjs'
import { loadInventory, ownValue, loadIntegrations, loadThirdPartyMeta } from './inventory.mjs'
import { loadServiceMap, serviceIdentity } from './service-map.mjs'
import { putFirst, recordRestPair, azureAppAddress } from './lib/assemble-rules.mjs'

const MS_PER_DAY = 86400000

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readScriptOutput(file) {
  return JSON.parse(fs.readFileSync(path.join(AUDIT, 'scripts', file), 'utf8'))
}

function addToListMap(map, key, value) {
  if (!map.has(key)) map.set(key, [])
  map.get(key).push(value)
}

// For plain objects that end up in the output JSON.
function pushToKey(object, key, value) {
  if (!object[key]) object[key] = []
  object[key].push(value)
}

// Curated per-repo knowledge (FE→BE notes, Azure name maps, …).
const repoExtra = readJson(path.join(AUDIT, 'repo-extra.json')) || {}
// The same config.json the viz reads; the pipeline only needs a few fields from it.
const appConfig = readJson(path.join(AUDIT, 'config.json')) || {}

// ---- Inventory ------------------------------------------------------------------------------
const { inventory, byRepo, byName, ignored } = loadInventory()
const serviceMap = loadServiceMap()
const thirdPartyMeta = loadThirdPartyMeta()
const integrations = loadIntegrations()

// Inventory entries get a serviceRepo only when service-map.json links a repo-less service to an
// owning repo. The repo-backed link is set on repos[] instead, which avoids a repoName≠folder edge.
function attachServiceIdentities() {
  for (const entry of inventory) Object.assign(entry, serviceIdentity(entry.name, null, serviceMap))
}

function attachThirdPartyMeta() {
  for (const entry of inventory) {
    const meta = thirdPartyMeta[entry.name.toLowerCase()]
    if (meta) entry.meta = meta
  }
}

attachServiceIdentities()
attachThirdPartyMeta()

// ---- Kafka integrations derived from code ----------------------------------------------------
// Producers and consumers are matched by topic, so service-to-service links come from the code
// instead of hand-maintained CSV rows. A topic with no consumer points at the shared Kafka bus;
// one with no producer comes from it. A curated CSV row for the same pair is kept, but marked
// verified because the code confirms it.
const KAFKA_BUS = 'Kafka'
const TOPICS_IN_LABEL = 3
const PAIR_SEPARATOR = '\u0000'

const backendTooling = readJson(path.join(AUDIT, 'backend-tooling.json'))

function addToSetMap(map, key, value) {
  if (!map.has(key)) map.set(key, new Set())
  map.get(key).add(value)
}

// The declaring module wins when it is an inventory component in its own right (the device-data-*
// modules ship as separate services); otherwise the repo's inventory name, else the repo name.
function componentOfRepo(folder, scan) {
  const repoName = scan.repoName || folder
  return ownValue(byRepo, repoName)?.[0]?.name || repoName
}

function componentOfChannel(channel, repoComponent) {
  const moduleComponent = channel.module && ownValue(byName, channel.module.toLowerCase())?.name
  return moduleComponent || repoComponent
}

function collectTopicEnds(scanned) {
  const producers = new Map() // topic -> Set(component)
  const consumers = new Map()
  for (const [folder, scan] of Object.entries(scanned)) {
    const repoComponent = componentOfRepo(folder, scan)
    for (const channel of scan.messaging || []) {
      const ends = channel.direction === 'outgoing' ? producers : consumers
      addToSetMap(ends, channel.topic, componentOfChannel(channel, repoComponent))
    }
  }
  return { producers, consumers }
}

// Returns "source<sep>target" -> Set(topic).
function pairUpTopics({ producers, consumers }) {
  const pairs = new Map()
  const link = (source, target, topic) => {
    if (source !== target) addToSetMap(pairs, source + PAIR_SEPARATOR + target, topic)
  }
  const allTopics = new Set([...producers.keys(), ...consumers.keys()])
  for (const topic of allTopics) {
    const topicProducers = [...(producers.get(topic) || [])]
    const topicConsumers = [...(consumers.get(topic) || [])]
    if (topicProducers.length && topicConsumers.length) {
      for (const producer of topicProducers) {
        for (const consumer of topicConsumers) link(producer, consumer, topic)
      }
    } else if (topicProducers.length) {
      for (const producer of topicProducers) link(producer, KAFKA_BUS, topic)
    } else {
      for (const consumer of topicConsumers) link(KAFKA_BUS, consumer, topic)
    }
  }
  return pairs
}

// The edge label shows the first few topics. When that truncates, the full list goes into
// `channelFull` so the renderer can show it on hover and no topic is silently hidden.
function channelLabels(topics) {
  const sorted = [...topics].sort()
  const hidden = sorted.length - TOPICS_IN_LABEL
  const channel = sorted.slice(0, TOPICS_IN_LABEL).join(', ') + (hidden > 0 ? ` +${hidden}` : '')
  const channelFull = sorted.join(', ')
  return channelFull === channel ? { channel } : { channel, channelFull }
}

// Only Kafka rows are indexed: a pair can talk both REST and Kafka, and Kafka evidence must never
// confirm (and so swallow) a REST row. The first row wins on duplicates.
function indexCuratedKafkaRows(rows) {
  const byPair = new Map()
  for (const row of rows) {
    if ((row.protocol || '').toLowerCase() !== 'kafka') continue
    const key = (row.source + PAIR_SEPARATOR + row.target).toLowerCase()
    if (!byPair.has(key)) byPair.set(key, row)
  }
  return byPair
}

function deriveKafkaIntegrations(scanned) {
  const pairs = pairUpTopics(collectTopicEnds(scanned))
  const curatedByPair = indexCuratedKafkaRows(integrations)
  let added = 0
  let confirmed = 0
  for (const [pairKey, topics] of pairs) {
    const labels = channelLabels(topics)
    const curated = curatedByPair.get(pairKey.toLowerCase())
    if (curated) {
      curated.verified = true
      curated.via = 'code'
      // Keeps the row's provenance: the Admin panel writes curated rows back to integrations.csv.
      curated.curated = true
      if (!curated.channel) Object.assign(curated, labels)
      confirmed++
    } else {
      const [source, target] = pairKey.split(PAIR_SEPARATOR)
      integrations.push({
        source,
        target,
        protocol: 'Kafka',
        ...labels,
        note: 'Derived from mp.messaging topics (backend-scan)',
        verified: true,
        via: 'code',
      })
      added++
    }
  }
  console.log(`kafka integrations derived from code: ${added} added, ${confirmed} CSV rows confirmed`)
}

if (backendTooling?.scanned) deriveKafkaIntegrations(backendTooling.scanned)

// ---- Curated backend topology ---------------------------------------------------------------
// Hosts, kinds, FE→BE wiring and backend→SaaS links that the scans can't derive. graph.js merges it
// with the live backend scan, so a newly cloned backend still appears. A missing or broken file
// leaves an empty overlay and backends fall back to scan-only.
function loadBackendTopology() {
  try {
    const extra = JSON.parse(fs.readFileSync(path.join(AUDIT, 'backend-extra.json'), 'utf8'))
    return {
      backends: extra.backends || [],
      feBe: extra.feBe || {},
      backendExternals: extra.backendExternals || {},
      assetConsumers: extra.assetConsumers || [],
      serviceEdges: extra.serviceEdges || [],
      contentRepos: extra.contentRepos || [],
      restHostAliases: extra.restHostAliases || {},
      ...(extra.assetsSource ? { assetsSource: extra.assetsSource } : {}),
    }
  } catch (error) {
    console.warn('backend-extra.json not loaded — backend overlay empty:', error.message)
    return {
      backends: [],
      feBe: {},
      backendExternals: {},
      assetConsumers: [],
      serviceEdges: [],
      contentRepos: [],
      restHostAliases: {},
    }
  }
}

const backendTopology = loadBackendTopology()

// ---- REST integrations derived from code -----------------------------------------------------
// Backends configure an outbound base URL instead of a typed client, so the URL host names the
// target service and the path is only a label. Each consumed host resolves to a component and
// becomes a REST edge, deduped against the CSV like the Kafka block. Provider @Path roots only
// refine the label, never gate an edge: consumers rarely restate the provider's full path. Hosts
// that resolve to nothing are reported for curation instead of being dropped.
const DEFAULT_PROTOCOL = 'REST'
const ENV_HOST_SEGMENT = /\.(dev|test|pre|prod|demo|poc|nonprod|sandbox|e2e)(?=\.)/g
const URL_PROPERTY_SUFFIX = /[._-]?(base-?url|url|endpoint)$/i

function backendAliases(backend) {
  return [backend.id, backend.repo, backend.label, backend.invAlias].filter(Boolean)
}

// Every alias of a backend node collapses to one name, so a derived row (keyed by inventory name)
// dedups against a CSV row keyed by the backend label or a pre-rename name.
function backendCanonicalizer(backends) {
  const canonicalByAlias = new Map()
  for (const backend of backends) {
    const canonicalName = backend.invAlias || backend.repo || backend.label || backend.id
    for (const alias of backendAliases(backend)) canonicalByAlias.set(alias.toLowerCase(), canonicalName)
  }
  return (name) => (name == null ? name : canonicalByAlias.get(String(name).toLowerCase()) || name)
}

function normalizeHost(host) {
  return String(host || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(ENV_HOST_SEGMENT, '.{env}')
    .toLowerCase()
}

function registeredDomain(host) {
  const labels = String(host).split('.')
  return labels.length > 1 ? labels.slice(-2).join('.') : host
}

function pathSegments(urlPath) {
  return (urlPath || '').split('/').filter(Boolean)
}

// Third parties resolve by their homepage's registered domain and by curated API hosts on other
// domains (googleapis.com, hana.ondemand.com). The proper-case inventory name is used when the
// service is a drawn node, so the edge renders.
function indexThirdParties(put) {
  for (const [lowerName, meta] of Object.entries(thirdPartyMeta)) {
    const name = ownValue(byName, lowerName)?.name || lowerName
    if (meta.url) put(registeredDomain(normalizeHost(meta.url)), name)
    for (const host of meta.hosts || []) {
      const normalized = normalizeHost(host)
      put(normalized, name)
      put(registeredDomain(normalized), name)
    }
  }
}

// Lowercased token -> canonical component. Backend host fields are indexed only as the full host,
// never the bare head ('api'), which would swallow unrelated externals like api.dsv.com.
function buildNodeIndex(canon) {
  const nodeIndex = new Map()
  const put = (token, name) => putFirst(nodeIndex, token, name)
  for (const entry of inventory) put(entry.name, canon(entry.name))
  for (const backend of backendTopology.backends) {
    const component = canon(backend.id)
    for (const alias of backendAliases(backend)) put(alias, component)
    if (backend.host) put(normalizeHost(backend.host), component)
  }
  indexThirdParties(put)
  // Curated aliases (a gateway path segment or host head) bypass put(): they exist to redirect a
  // token, so they must beat any derived entry already indexed under it.
  for (const [token, target] of Object.entries(backendTopology.restHostAliases)) {
    if (token.startsWith('_')) continue // the _comment key
    nodeIndex.set(token.toLowerCase(), canon(ownValue(byName, target.toLowerCase())?.name || target))
  }
  return nodeIndex
}

// Component -> Set(@Path root) of what it provides.
function collectProviderRoots(scanned, canon) {
  const rootsByComponent = new Map()
  for (const [folder, scan] of Object.entries(scanned)) {
    const repoComponent = componentOfRepo(folder, scan)
    for (const provider of scan.restProvides || []) {
      const component = canon(componentOfChannel(provider, repoComponent))
      if (!rootsByComponent.has(component)) rootsByComponent.set(component, new Set())
      for (const root of provider.roots || []) rootsByComponent.get(component).add(root)
    }
  }
  return rootsByComponent
}

// Candidates run most specific first. Path segments beat the host head because a gateway host
// (skycore/<service>) names the real service in the path. The domain and its first label come
// last, for third parties.
function resolveRestTarget(consumer, nodeIndex) {
  const segments = pathSegments(consumer.path)
  const domain = registeredDomain(consumer.host)
  const candidates = [
    segments[0],
    segments[1],
    consumer.host,
    consumer.hostHead,
    domain,
    domain.split('.')[0],
  ]
  for (const token of candidates.filter(Boolean)) {
    const component = nodeIndex.get(token.toLowerCase())
    if (component) return component
  }
  return null
}

function restChannel(consumer, providerRoots) {
  const firstSegment = '/' + (pathSegments(consumer.path)[0] || '')
  // The path starts with a real @Path root on the target, so the label is confirmed.
  if (providerRoots && providerRoots.has(firstSegment)) return firstSegment
  if (consumer.path && consumer.path !== '/') return consumer.path
  return consumer.propKey.replace(URL_PROPERTY_SUFFIX, '')
}

const rowRank = (row) => (row.via === 'code' ? 2 : 0) + (row.verified ? 1 : 0)

// A backend can be in the CSV under both a pre-rename and a current name: two rows for one edge.
// Keeps one row per key, preferring the code-derived / verified one and filling its gaps from the
// other. Returns how many rows were dropped.
function mergeAliasDuplicates(integrationKey) {
  const bestByKey = new Map()
  for (const row of integrations) {
    const key = integrationKey(row.source, row.target, row.protocol)
    const previous = bestByKey.get(key)
    if (!previous) {
      bestByKey.set(key, row)
      continue
    }
    const [winner, loser] = rowRank(row) > rowRank(previous) ? [row, previous] : [previous, row]
    if (!winner.channel && loser.channel) winner.channel = loser.channel
    if (!winner.note && loser.note) winner.note = loser.note
    if (loser.curated) winner.curated = true
    bestByKey.set(key, winner)
  }
  const removed = integrations.length - bestByKey.size
  integrations.length = 0
  integrations.push(...bestByKey.values())
  return removed
}

function deriveRestIntegrations(scanned) {
  const canon = backendCanonicalizer(backendTopology.backends)
  // Keyed by protocol too: a pair can talk both REST and Kafka, and one must never confirm the other.
  const integrationKey = (source, target, protocol) =>
    `${canon(source)}${PAIR_SEPARATOR}${canon(target)}${PAIR_SEPARATOR}${(protocol || DEFAULT_PROTOCOL).toLowerCase()}`
  const nodeIndex = buildNodeIndex(canon)
  const rootsByComponent = collectProviderRoots(scanned, canon)
  const restRows = {
    curatedByKey: new Map(
      integrations.map((row) => [integrationKey(row.source, row.target, row.protocol), row]),
    ),
    derivedByKey: new Map(),
  }
  const unresolvedHosts = new Map() // host -> Set(source)
  let added = 0
  let confirmed = 0

  for (const [folder, scan] of Object.entries(scanned)) {
    const repoComponent = componentOfRepo(folder, scan)
    for (const consumer of scan.restConsumes || []) {
      const source = canon(componentOfChannel(consumer, repoComponent))
      const target = resolveRestTarget(consumer, nodeIndex)
      if (!target) {
        addToSetMap(unresolvedHosts, consumer.host, source)
        continue
      }
      if (target === source) continue // e.g. ip.be.application.url pointing at its own host
      const channel = restChannel(consumer, rootsByComponent.get(target))
      const row = {
        source,
        target,
        protocol: DEFAULT_PROTOCOL,
        channel,
        note: 'Derived from outbound URL config (backend-scan)',
        verified: true,
        via: 'code',
      }
      const outcome = recordRestPair(restRows, integrationKey(source, target, DEFAULT_PROTOCOL), row)
      if (outcome === 'confirmed') confirmed++
      if (outcome === 'added') {
        integrations.push(row)
        added++
      }
    }
  }

  const merged = mergeAliasDuplicates(integrationKey)
  const unresolvedList = [...unresolvedHosts.keys()].sort()
  const unresolvedDetail = unresolvedList.length ? ' (' + unresolvedList.join(', ') + ')' : ''
  console.log(
    `rest integrations derived from code: ${added} added, ${confirmed} CSV rows confirmed, ${merged} alias-duplicate rows merged, ${unresolvedList.length} unresolved hosts${unresolvedDetail}`,
  )
}

if (backendTooling?.scanned) deriveRestIntegrations(backendTooling.scanned)

// ---- Scanned repos ---------------------------------------------------------------------------
const gather = readScriptOutput('gather-out.json')
const workflowsByFolder = readScriptOutput('workflows-out.json')
const moduleGraphsByFolder = readScriptOutput('modulegraph-out.json')

// GitHub repos renamed or deleted since the clone was made (sync-names.mjs). Renames apply here so
// links stay canonical before the local folder catches up; both show up in pipeline health.
const nameDrift = readJson(path.join(AUDIT, 'name-drift.json'))
const renamedUrls = new Map(
  (nameDrift?.renames || []).map((rename) => [rename.from.toLowerCase(), rename.url]),
)
const GITHUB_SLUG = /github\.com\/([^/]+\/[^/.]+)/i

// Remotes come from each clone's own origin URL, so there is no curated URL map to drift.
const remotes = new Map() // folder -> remote URL
const renamedBasenames = new Map() // folder -> repo basename after a GitHub rename

function renamedRemote(url) {
  const slug = String(url || '').match(GITHUB_SLUG)?.[1]
  const renamed = slug && renamedUrls.get(slug.toLowerCase())
  return renamed ? renamed + '.git' : null
}

function collectRemotes() {
  for (const { folder } of gather) {
    const url = remoteOf(folder)
    const renamed = renamedRemote(url)
    if (renamed) {
      // Keeps inventory matching working for a folder still under its old name.
      renamedBasenames.set(
        folder,
        renamed
          .split('/')
          .pop()
          .replace(/\.git$/, ''),
      )
    }
    remotes.set(folder, renamed || url)
  }
}

collectRemotes()

function inventoryFor(folder) {
  const direct = ownValue(byRepo, folder)?.[0]
  if (direct) return direct
  const renamed = renamedBasenames.get(folder)
  return (renamed && ownValue(byRepo, renamed)?.[0]) || null
}

// Graph node kind from the component's type-* topic. type-third-party-service never applies to a
// cloned repo.
const KIND_BY_TYPE = {
  Client: 'client',
  Service: 'service',
  Library: 'library',
  Assets: 'assets',
  Tests: 'tests',
  'Third-Party Service': 'external',
  Firmware: 'firmware',
  Infrastructure: 'infrastructure',
  Hardware: 'hardware',
  Data: 'data',
  Config: 'config',
}

const remoteFor = (folder) => remotes.get(folder) ?? null
// The same org test repo discovery uses, so a repo accepted there can't fall out of scope here.
const isOrgRepo = (folder) => inOrg(remoteFor(folder))

function kindFor(folder) {
  if (!isOrgRepo(folder)) return 'external-repo'
  return KIND_BY_TYPE[inventoryFor(folder)?.type] || 'service'
}

// Curated FE→backend notes (env vars and backend hosts) per repo.
const feToBe = repoExtra.feToBe || {}

function resolvedVersion(tool) {
  return tool ? (tool.resolved ?? tool.declared ?? null) : null
}

function buildToolOf(scripts, tooling) {
  const usesReactScripts =
    scripts?.start?.includes('craco') ||
    scripts?.start?.includes('react-scripts') ||
    scripts?.build?.includes('react-scripts')
  if (usesReactScripts) return 'CRA/craco (react-scripts)'
  if (resolvedVersion(tooling.vite)) return 'vite'
  if (scripts?.dev?.includes('astro')) return 'astro'
  return 'other'
}

function toolingVersionsOf(gathered) {
  const tooling = gathered.tooling
  return {
    react: resolvedVersion(tooling.react),
    vite: resolvedVersion(tooling.vite),
    typescript: resolvedVersion(tooling.typescript),
    mui: resolvedVersion(tooling.mui),
    storybook: tooling.storybook.pkg
      ? `${tooling.storybook.pkg}@${resolvedVersion(tooling.storybook)}`
      : null,
    node: tooling.node.value ? `${tooling.node.value} (${tooling.node.source})` : null,
    buildTool: buildToolOf(gathered.scripts, tooling),
  }
}

function deploymentsOf(folder) {
  const deploys = (workflowsByFolder[folder] || [])
    .filter((workflow) => workflow.deploys)
    .map((workflow) => ({
      workflow: workflow.file,
      triggers: workflow.triggers,
      branches: workflow.branches,
      environments: workflow.environments,
      target: workflow.target,
    }))
  return deploys.length ? deploys : [{ note: 'no deploying workflow detected' }]
}

function moduleGraphOf(folder) {
  const graph = moduleGraphsByFolder[folder]
  if (!graph) return { method: 'grep', crossFolderEdges: 0, edges: [], note: 'no src/ dir' }
  return {
    method: graph.method,
    crossFolderEdges: graph.crossFolderEdges,
    srcFiles: graph.srcFiles ?? null,
    topFolders: graph.topFolders ?? null,
    edges: graph.edges,
  }
}

function scannedRepo(gathered) {
  const folder = gathered.folder
  return {
    folder,
    // Follows renames sync-names detected, even before the local folder moves.
    displayName: renamedBasenames.get(folder) || folder,
    kind: kindFor(folder),
    inOrg: isOrgRepo(folder),
    remote: remoteFor(folder),
    name: gathered.name,
    version: gathered.version,
    defaultBranch: gathered.defaultBranch,
    lastCommit: gathered.lastCommitDate,
    externals: gathered.externals || [],
    endpoints: gathered.endpoints || [],
    endpointLinks: gathered.endpointLinks || {},
    liveUrl: gathered.liveUrl ?? null,
    apiUrl: gathered.apiUrl ?? null,
    swagger: gathered.swagger ?? null,
    internalDeps: gathered.internalDeps.map((dep) => ({
      name: dep.name,
      version: dep.version,
      dev: dep.dev,
    })),
    legacyPackages: gathered.legacyPackages,
    toolingVersions: toolingVersionsOf(gathered),
    moduleGraph: moduleGraphOf(folder),
    deployment: deploymentsOf(folder),
    feToBe: feToBe[folder] || { method: 'grep', backends: [] },
  }
}

const allScanned = gather.map(scannedRepo)

for (const repo of allScanned) {
  const entry = inventoryFor(repo.folder)
  if (entry) repo.inventory = entry
}

// ---- Duplicate clones ------------------------------------------------------------------------
// Two local clones of one GitHub repo (e.g. a leftover checkout under the pre-rename folder) would
// draw two cards. Keep the clone whose folder matches the repo basename, else the freshest.
function pickCanonicalClone(clones) {
  const basename = clones[0].remote
    .split('/')
    .pop()
    .replace(/\.git$/i, '')
  const byNewestCommit = (a, b) => String(b.lastCommit || '').localeCompare(String(a.lastCommit || ''))
  return clones.find((clone) => clone.folder === basename) || [...clones].sort(byNewestCommit)[0]
}

function findDuplicateClones(scannedRepos) {
  const clonesByRemote = new Map()
  for (const repo of scannedRepos) {
    if (repo.remote) addToListMap(clonesByRemote, repo.remote.toLowerCase(), repo)
  }
  const messages = []
  const shadowed = new Set()
  for (const clones of clonesByRemote.values()) {
    if (clones.length < 2) continue
    const kept = pickCanonicalClone(clones)
    for (const clone of clones) {
      if (clone === kept) continue
      shadowed.add(clone.folder)
      messages.push(`${clone.folder} — same repo as ${kept.folder} (stale clone, remove it)`)
    }
  }
  return { duplicateClones: messages, shadowed }
}

const { duplicateClones, shadowed } = findDuplicateClones(allScanned)

// ---- Drawn repos -----------------------------------------------------------------------------
// The map shows curated components only: repos with inventory topics. The org-wide clone also
// pulls in POCs, archived repos and the like; they have no topics and are listed as a curation
// backlog instead (validation.uncuratedRepos).
const repos = allScanned.filter((repo) => repo.inventory && !shadowed.has(repo.folder))
for (const repo of repos) {
  Object.assign(repo, serviceIdentity(repo.inventory?.name ?? repo.folder, repo.folder, serviceMap))
}

const uncuratedRepos = allScanned
  .filter(
    (repo) =>
      !repo.inventory &&
      !shadowed.has(repo.folder) &&
      !OUTSIDE.includes(repo.folder) &&
      !ignored.has(repo.folder),
  )
  .map((repo) => repo.folder)

const DEFAULT_NEW_REPO_DAYS = 90
const NEW_REPO_DAYS =
  Number(process.env.ARCH_NEW_REPO_DAYS) > 0 ? Number(process.env.ARCH_NEW_REPO_DAYS) : DEFAULT_NEW_REPO_DAYS

const isNewRepo = (repo) =>
  repo.inventory?.createdAt && Date.now() - Date.parse(repo.inventory.createdAt) < NEW_REPO_DAYS * MS_PER_DAY
const newlyDiscovered = repos.filter(isNewRepo).map((repo) => repo.folder)

// ---- Design system and version drift ---------------------------------------------------------
// Every package name that resolves to the single `ui` hub card: a package mid-rename is pinned
// under both names. Keep in sync with DEFAULT_UI_PACKAGES in graph.js.
const UI_PACKAGES = new Set(Array.isArray(appConfig.uiPackages) ? appConfig.uiPackages : [])
const isUiPackage = (name) => UI_PACKAGES.has(name)
// Folders the design-system repo is checked out under, to compare its own version with the pins.
const UI_HUB_FOLDERS =
  Array.isArray(appConfig.uiHubFolders) && appConfig.uiHubFolders.length ? appConfig.uiHubFolders : ['ui']
const UI_DRIFT_KEY = [...UI_PACKAGES][0] || 'design system'

// The design system itself is excluded: it yalc-links its own package during local dev, which
// would register as a self-consumer with a bogus file: version.
const uiConsumers = repos
  .filter((repo) => !isUiPackage(repo.name) && repo.internalDeps.some((dep) => isUiPackage(dep.name)))
  .map((repo) => ({
    repo: repo.folder,
    version: repo.internalDeps.find((dep) => isUiPackage(dep.name)).version,
  }))
const legacyPackages = repos.filter((repo) => repo.legacyPackages).map((repo) => repo.folder)

// Read from the ui repo's own package.json. Never hardcode it: a literal would be re-emitted
// on every refresh as if measured.
function uiLibrarySourceVersions() {
  const version = repos.find((repo) => UI_HUB_FOLDERS.includes(repo.folder))?.version
  return version ? [{ repo: 'ui (library source HEAD)', version }] : []
}

// A plain object on purpose: its key order is emitted as is.
function driftFor(versionOf) {
  const foldersByVersion = {}
  for (const repo of repos) {
    const version = versionOf(repo)
    if (version) pushToKey(foldersByVersion, version, repo.folder)
  }
  if (Object.keys(foldersByVersion).length <= 1) return []
  return Object.entries(foldersByVersion).map(([version, folders]) => ({ version, repos: folders }))
}

const versionDrift = {
  [UI_DRIFT_KEY]: uiConsumers
    .map((consumer) => ({ repo: consumer.repo, version: consumer.version }))
    .concat(uiLibrarySourceVersions()),
  mui: driftFor((repo) => repo.toolingVersions.mui),
  storybook: driftFor((repo) => repo.toolingVersions.storybook),
  node: driftFor((repo) => repo.toolingVersions.node),
  react: driftFor((repo) => repo.toolingVersions.react),
  typescript: driftFor((repo) => repo.toolingVersions.typescript),
  vite: driftFor((repo) => repo.toolingVersions.vite),
}

// Hand-written, dated observations a scan can't make. Emitted under an explicit asOf so consumers
// can tell them from the measured fields. Bump NOTES_AS_OF when adding some.
const NOTES_AS_OF = null
const notes = []

// ---- Pipeline self-checks (graph.js adds the Unclassified-repo check) --------------------------
const REQUIRED_CURATION_FIELDS = ['owner', 'status', 'description']

// Repo-backed components that are on the map but render with gaps.
function incompleteCuration() {
  return inventory
    .filter((entry) => entry.repoName && entry.type)
    .map((entry) => {
      const missing = REQUIRED_CURATION_FIELDS.filter((field) => !entry[field])
      return missing.length ? `${entry.name} — missing ${missing.join(', ')}` : null
    })
    .filter(Boolean)
}

// An archived repo is read-only, so its status topic can't be fixed in place. Flag it for a human
// instead of silently forcing it to Removed.
function statusMismatches() {
  return inventory
    .filter((entry) => entry.archived && entry.status !== 'Removed')
    .map((entry) => {
      const status = entry.status ? `"${entry.status}"` : 'unset'
      return `${entry.name} — archived on GitHub but status is ${status} (should be Removed)`
    })
}

const orgRepos = repos.filter((repo) => repo.inOrg !== false && repo.kind !== 'external-repo')
const validation = {
  newlyDiscovered,
  unclonedOrgRepos: process.env.ATLAS_DISCOVER === '1' ? uncloned() : [],
  // No last commit means the git read failed, so the clone's data is unreliable.
  staleClones: orgRepos.filter((repo) => !repo.lastCommit).map((repo) => repo.folder),
  duplicateClones,
  repoRenames: (nameDrift?.renames || []).map(
    (rename) => `${rename.from} → ${rename.to} (${[...rename.foundIn].join(', ')})`,
  ),
  repoMissingOnGitHub: (nameDrift?.missing || []).map(
    (missing) => `${missing.repo} (${[...missing.foundIn].join(', ')})`,
  ),
  uncuratedRepos,
  incompleteCuration: incompleteCuration(),
  statusMismatch: statusMismatches(),
}

// ---- Azure overlay ---------------------------------------------------------------------------
// What is actually deployed (azure-gather.mjs, optional), mapped onto repos and inventory entries
// and cross-checked against the curated data.
const REMOVED_BUT_DEPLOYED_DAYS = 180
const azure = readJson(path.join(AUDIT, 'azure-resources.json'))
const githubMeta = readJson(path.join(AUDIT, 'github-meta.json'))

// Azure app key -> repo folder, and ACR image -> inventory name. Owners set them as repo custom
// properties (azure-app-key, comma/space separated; acr-image), which win over repo-extra.json.
const azureAppMap = new Map(Object.entries(repoExtra.azureAppMap || {}))
const acrAlias = new Map(Object.entries(repoExtra.acrAlias || {}))
// First-party registries. Images from elsewhere are recorded but never scaffolded into the
// inventory. Unset means every registry counts.
const ACR_REGISTRIES = Array.isArray(appConfig.containerRegistries) ? appConfig.containerRegistries : []

function applyAzureRepoProperties() {
  for (const [name, repo] of Object.entries(githubMeta?.repos || {})) {
    const props = repo.props || {}
    const appKeys = String(props['azure-app-key'] || '')
      .split(/[\s,]+/)
      .filter(Boolean)
    for (const key of appKeys) azureAppMap.set(key, name)
    if (props['acr-image']) acrAlias.set(props['acr-image'], inventoryFor(name)?.name || name)
  }
}

applyAzureRepoProperties()

const moduleUrlOf = (env) => (env?.path && env.domains?.[0] ? env.domains[0] + env.path : null)

// Two apps can map to one repo (skytrack + skytrackv2); per env the freshest deploy wins.
function mergeAppEnv(envs, envName, incoming) {
  const current = envs[envName]
  if (current && (current.deployed || '') >= (incoming.deployed || '')) {
    if (!current.domains?.length && incoming.domains?.length) current.domains = incoming.domains
    // A path-routed module folded into a full site keeps its URL visible.
    const moduleUrl = moduleUrlOf(incoming)
    if (moduleUrl) current.modules = [...new Set([...(current.modules || []), moduleUrl])]
    return
  }
  const moduleUrl = moduleUrlOf(current)
  envs[envName] = {
    domains: incoming.domains?.length ? incoming.domains : current?.domains || [],
    deployed: incoming.deployed || null,
    storage: incoming.storage || null,
    path: incoming.path || null,
    modules: [...new Set([...(current?.modules || []), ...(moduleUrl ? [moduleUrl] : [])])],
  }
}

function attachAzureApps() {
  const repoByFolder = new Map(repos.map((repo) => [repo.folder, repo]))
  for (const [app, appData] of Object.entries(azure.apps || {})) {
    const repo = repoByFolder.get(azureAppMap.get(app))
    if (!repo) continue
    repo.azure = repo.azure || { envs: {} }
    for (const [envName, env] of Object.entries(appData.envs)) mergeAppEnv(repo.azure.envs, envName, env)
  }
  for (const repo of repos) {
    if (!repo.azure) continue
    repo.azure.lastDeploy =
      Object.values(repo.azure.envs)
        .map((env) => env.deployed)
        .filter(Boolean)
        .sort()
        .pop() || null
    // The real prod domain beats the curated {env} template.
    const prod = repo.azure.envs.prod
    if (prod?.domains?.length) repo.liveUrl = prod.domains[0]
  }
}

function inventoryIndex() {
  const byLowerName = new Map(inventory.map((entry) => [entry.name.toLowerCase(), entry]))
  const byLowerRepo = new Map(
    inventory.filter((entry) => entry.repoName).map((entry) => [entry.repoName.toLowerCase(), entry]),
  )
  return {
    find: (key) => byLowerName.get(key.toLowerCase()) || byLowerRepo.get(key.toLowerCase()) || null,
    add: (entry, key) => {
      byLowerName.set(key.toLowerCase(), entry)
      byLowerRepo.set(key.toLowerCase(), entry)
    },
  }
}

function scaffoldEntry(repo, image, lastPush, repoMeta) {
  return {
    name: repo,
    abbr: '',
    type: 'Service',
    status: '',
    owner: '',
    applications: [],
    description: repoMeta.description || '',
    contact: '',
    introDate: '',
    sunsetDate: '',
    comment: '',
    doc: '',
    repo: repoMeta.url,
    repoName: repo,
    scaffold: true,
    azure: { image, lastPush },
  }
}

// ACR images -> inventory entries. An image with no entry but a same-named GitHub repo gets a
// scaffold entry, so it shows up as "awaiting curation" instead of only as a warning.
function attachAcrImages(index) {
  const unknown = []
  const scaffolded = []
  for (const [registry, imagesByRepo] of Object.entries(azure.acr || {})) {
    for (const [repo, meta] of Object.entries(imagesByRepo)) {
      const image = `${registry}.azurecr.io/${repo}`
      // The raw repo name is the fallback, so an entry that matches it is merged into rather than
      // duplicated by a scaffold.
      const alias = acrAlias.get(repo)
      const entry = index.find(alias || repo) || (alias && index.find(repo))
      if (entry) {
        entry.azure = { ...entry.azure, image, lastPush: meta.lastPush }
        continue
      }
      // An upstream mirror's images aren't components.
      if ((ACR_REGISTRIES.length && !ACR_REGISTRIES.includes(registry)) || repo.includes('/')) continue
      const repoMeta = githubMeta?.repos?.[repo]
      if (repoMeta && (repoMeta.topics || []).includes('arch-map-ignore')) continue
      if (!repoMeta) {
        unknown.push(repo)
        continue
      }
      const scaffold = scaffoldEntry(repo, image, meta.lastPush, repoMeta)
      inventory.push(scaffold)
      index.add(scaffold, repo)
      scaffolded.push(repo)
    }
  }
  return { unknown, scaffolded }
}

function attachAzureInfra(index) {
  for (const resource of azure.infra || []) {
    const entry = resource.service && index.find(acrAlias.get(resource.service) || resource.service)
    if (!entry) continue
    entry.azure = entry.azure || {}
    pushToKey(entry.azure, 'infra', {
      name: resource.name,
      type: resource.type.split('/').pop(),
      env: resource.env,
    })
  }
}

const isRecent = (iso, days) => iso && Date.now() - new Date(iso).getTime() < days * MS_PER_DAY

function unmappedAzureApps() {
  return Object.entries(azure.apps || {})
    .filter(
      ([app, appData]) =>
        !azureAppMap.get(app) && Object.values(appData.envs).some((env) => env.domains?.length),
    )
    .map(([app, appData]) => `${app} → ${azureAppAddress(appData.envs)}`)
}

// Deployed envs the repo's workflows don't know about. Sandbox is expected to be ad hoc.
function azureEnvDrift() {
  return repos
    .filter((repo) => repo.azure)
    .map((repo) => {
      const workflowEnvs = new Set(repo.deployment.flatMap((deploy) => deploy.environments || []))
      if (!workflowEnvs.size) return null
      const extra = Object.keys(repo.azure.envs).filter((env) => !workflowEnvs.has(env) && env !== 'sandbox')
      return extra.length ? `${repo.folder}: deployed ${extra.join(', ')} not in workflows` : null
    })
    .filter(Boolean)
}

// Mappings that point at Azure names that no longer exist, or at renamed inventory components.
function staleAzureMappings(index) {
  const knownAcrNames = new Set([
    ...Object.values(azure.acr || {}).flatMap((imagesByRepo) => Object.keys(imagesByRepo)),
    ...(azure.infra || []).map((resource) => resource.service).filter(Boolean),
  ])
  return [
    ...[...azureAppMap.keys()]
      .filter((key) => !azure.apps?.[key])
      .map((key) => `azureAppMap '${key}' — no such app in Azure anymore`),
    ...[...acrAlias.keys()]
      .filter((key) => !knownAcrNames.has(key))
      .map((key) => `acrAlias '${key}' — not found in ACR or infra names`),
    // The infra lookup has no raw-name fallback, so a stale alias target silently drops that
    // component's azure.infra.
    ...[...acrAlias]
      .filter(([, target]) => !index.find(target))
      .map(([key, target]) => `acrAlias '${key}' → '${target}' — no such inventory component (renamed?)`),
  ]
}

function applyAzureOverlay() {
  attachAzureApps()
  const index = inventoryIndex()
  const { unknown, scaffolded } = attachAcrImages(index)
  attachAzureInfra(index)
  Object.assign(validation, {
    azureUnmappedApps: unmappedAzureApps(),
    azureEnvDrift: azureEnvDrift(),
    azureRemovedButDeployed: inventory
      .filter(
        (entry) =>
          /removed|sunsetting/i.test(entry.status) &&
          isRecent(entry.azure?.lastPush, REMOVED_BUT_DEPLOYED_DAYS),
      )
      .map((entry) => `${entry.name} (image pushed ${entry.azure.lastPush.slice(0, 10)})`),
    azureNeedsCuration: scaffolded.map(
      (repo) => `${repo} — set type-/owner-/status-/app- topics on the repo`,
    ),
    azureAcrNotInInventory: unknown,
    azureStaleMappings: staleAzureMappings(index),
  })
}

if (azure) applyAzureOverlay()

// ---- Language and framework (measured, never curated) ------------------------------------------
// Priority per component: the backend build-file scan (matched by owning repo, so monorepo services
// are covered), then the FE clone's tooling versions, then GitHub's primary language.
function backendStacksByRepo() {
  const stacks = new Map()
  for (const [folder, scan] of Object.entries(backendTooling?.scanned || {})) {
    stacks.set((scan.repoName || folder).toLowerCase(), {
      language: scan.java || 'Java',
      framework: scan.framework || null,
    })
  }
  return stacks
}

function frontendStackOf(repo) {
  const tooling = repo?.toolingVersions
  if (!tooling) return null
  if (!tooling.typescript && !tooling.react && !tooling.vite && !tooling.node && !tooling.buildTool)
    return null
  return {
    language: tooling.typescript ? 'TypeScript' : 'JavaScript',
    framework: tooling.react ? `React ${String(tooling.react).replace(/^[~^>=<\s]+/, '')}` : null,
  }
}

function githubStackOf(repoName) {
  const language = githubMeta?.repos?.[repoName]?.language
  return language ? { language, framework: null } : null
}

function applyStack(target, stack) {
  if (!stack) return
  target.language = stack.language
  if (stack.framework) target.framework = stack.framework
}

function attachStacks() {
  const backendStacks = backendStacksByRepo()
  const repoByFolderOrName = new Map()
  for (const repo of repos) {
    repoByFolderOrName.set(repo.folder.toLowerCase(), repo)
    if (repo.displayName) repoByFolderOrName.set(repo.displayName.toLowerCase(), repo)
  }
  for (const entry of inventory) {
    const owningRepo = (entry.serviceRepo || entry.repoName || '').toLowerCase()
    applyStack(
      entry,
      backendStacks.get(owningRepo) ||
        frontendStackOf(repoByFolderOrName.get(owningRepo)) ||
        githubStackOf(entry.repoName),
    )
  }
  for (const repo of repos) {
    applyStack(repo, frontendStackOf(repo) || githubStackOf(repo.displayName || repo.folder))
  }
}

attachStacks()

// ---- Framework adoption (the backend counterpart of uiConsumers) -----------------------------
// Framework name -> the services building on it, from the build files backend-scan read.
function collectFrameworkConsumers() {
  const consumers = {}
  for (const [folder, scan] of Object.entries(backendTooling?.scanned || {})) {
    const repoComponent = componentOfRepo(folder, scan)
    for (const [framework, info] of Object.entries(scan.frameworks || {})) {
      pushToKey(consumers, framework, {
        name: repoComponent,
        version: info.version,
        artifacts: info.artifacts,
      })
    }
  }
  return consumers
}

const frameworkConsumers = collectFrameworkConsumers()

// ---- Output ----------------------------------------------------------------------------------
// Nothing detects locally present but uncloned repos yet, so this stays empty.
const missingRepos = []

function azureSummary() {
  if (!azure) return null
  return {
    generatedAt: azure.generatedAt,
    subscription: azure.subscription?.name,
    tenant: azure.subscription?.tenant,
    warnings: azure.warnings,
  }
}

const out = {
  org: ORG,
  generatedAt: new Date().toISOString(),
  // Only the directory name: this file is committed and must not publish the runner's home layout.
  scanRoot: path.basename(ROOT),
  azure: azureSummary(),
  validation,
  inventory,
  integrations,
  backendTopology,
  missingRepos,
  repoCounts: {
    withPackageJson: repos.length,
    missing: missingRepos.length,
    inOrg: repos.filter((repo) => repo.inOrg).length,
    outsideOrg: repos.filter((repo) => !repo.inOrg).length,
  },
  repos,
  uiConsumers,
  frameworkConsumers,
  legacyPackages,
  versionDrift,
  notes: { asOf: NOTES_AS_OF, items: notes },
}
fs.writeFileSync(path.join(AUDIT, 'fe-architecture.json'), JSON.stringify(out, null, 2))
console.log('wrote fe-architecture.json; repos:', repos.length)
