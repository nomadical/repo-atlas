import dagre from '@dagrejs/dagre'
import { MarkerType } from '@xyflow/react'

const nonEmptyOr = (list, fallback) => (Array.isArray(list) && list.length ? list : fallback)

function addToListMap(map, key, value) {
  if (!map.has(key)) map.set(key, [])
  map.get(key).push(value)
}

// Design-system package names (config.json `uiPackages`) that all collapse onto the single `ui` hub
// card. List both names of a package mid-rename. Empty means no hub card is drawn.
// Kept in sync with UI_PACKAGES in scripts/assemble.mjs.
export const DEFAULT_UI_PACKAGES = []
export const uiPackagesOf = (config) =>
  new Set(Array.isArray(config?.uiPackages) ? config.uiPackages : DEFAULT_UI_PACKAGES)

// Repo folders the design-system hub card can appear under (config.json `uiHubFolders`).
export const uiHubFoldersOf = (config) => nonEmptyOr(config?.uiHubFolders, ['ui'])

// A card's node id is the inventory serviceId, falling back to the repo folder for data that
// predates serviceIds. The folder stays a permanent alias for old ?sel= links, saved views and
// config.json layout keys; see applyLayoutOverrides and App.jsx's matchSelNode.
export const nodeIdOf = (repo) => repo.serviceId || repo.folder

export const KIND = {
  client: { label: 'Client', color: '#1e88e5' },
  library: { label: 'Library', color: '#7c4dff' },
  service: { label: 'Service', color: '#00897b' },
  // `backend` and `extsvc` drive layout and pruning, but to a curator they are just their inventory
  // Type, so they share that Type's label and color everywhere a user sees them.
  backend: { label: 'Service', color: '#00897b' },
  extsvc: { label: 'Third-Party Service', color: '#5e35b1' },
  storage: { label: 'Storage (blob)', color: '#546e7a' },
  assets: { label: 'Assets', color: '#90a4ae' },
  content: { label: 'Content repo', color: '#8d6e63' },
  external: { label: 'Third-Party Service', color: '#5e35b1' },
  tests: { label: 'Tests', color: '#43a047' },
  personal: { label: 'Personal', color: '#bdbdbd' },
  package: { label: 'Internal package', color: '#b39ddb' },
  infra: { label: 'Deployment target', color: '#ef5350' },
  component: { label: 'Component (inventory)', color: '#26a69a' },
  firmware: { label: 'Firmware', color: '#ff7043' },
  infrastructure: { label: 'Infrastructure', color: '#78909c' },
  hardware: { label: 'Hardware', color: '#a1887f' },
  data: { label: 'Data', color: '#ffb300' },
  config: { label: 'Config', color: '#9ccc65' },
  bus: { label: 'Event bus', color: '#455a64' },
  // Per-client drill-down (clientGraph.js); the backend tier reuses the Service color.
  screen: { label: 'Screen', color: '#1e88e5' },
  endpoint: { label: 'Endpoint', color: '#00838f' },
}

// Wherever nodes are grouped or counted by kind, a backend and a service must land in one
// "Service" bucket, not two.
export const KIND_ALIAS = { backend: 'service', extsvc: 'external' }
export const canonKind = (kind) => KIND_ALIAS[kind] || kind

// Chip color per product tag, merged with config.json `tagColors`.
export const TAG_COLOR = {}

// Deploy-target nodes. `match` is a case-insensitive regex over a repo's workflow deployment
// targets; `testsFallback` marks the node that test-harness repos without a target link to.
// config.json `deployTargets` replaces the whole list.
const DEFAULT_DEPLOY_TARGETS = [
  { id: 'inf-blob', label: 'Azure Storage $web\n+ Front Door/CDN', match: 'blob|\\$web|front door' },
  { id: 'inf-acr', label: 'Azure Container Registry\n+ docker-compose', match: 'container' },
  { id: 'inf-ci', label: 'GitHub Actions\n(CI)', testsFallback: true },
]
const deployTargetsOf = (config) => nonEmptyOr(config?.deployTargets, DEFAULT_DEPLOY_TARGETS)

// Detail layers, shared by the toolbar, the URL codec and buildGraph. Each layer adds a class of
// node. `param` is the URL query key: shared and embedded links depend on it, so never rename it.
export const LAYERS = [
  { key: 'backends', param: 'be', label: 'Resources', default: true },
  { key: 'integrations', param: 'int', label: 'Integrations', default: false },
  { key: 'deploy', param: 'dpl', label: 'Deployments', default: true },
  // Not "Components": everything on the map is a component. This draws the rest of the inventory.
  { key: 'components', param: 'comp', label: 'Inventory catalog', default: false },
  { key: 'serviceLinks', param: 'links', label: 'Service links', default: false },
]
export const DEFAULT_LAYERS = Object.fromEntries(LAYERS.map((layer) => [layer.key, layer.default]))

// Arrow classes a user can show or hide. `key` is the id used by the hide-by-type filter and the
// `hedge` URL param; color and dash mirror the drawn arrow so the Legend swatch matches.
export const EDGE_TYPES = [
  { key: 'dependency', color: '#7c4dff', dash: 'solid', label: 'Design-system dependency' },
  // A dependency edge whose version is behind the highest one in use. Classified by
  // edge.data.drift, not by id: it shares the dep- prefix.
  { key: 'drift', color: '#e53935', dash: 'dashed', label: 'Design-system version lag' },
  { key: 'febe', color: '#fb8c00', dash: 'solid', label: 'FE → resource' },
  { key: 'bebe', color: '#6d4c41', dash: 'dashed', label: 'Backend ↔ backend' },
  { key: 'rest', color: '#00838f', dash: 'solid', label: 'Service link (REST)' },
  { key: 'kafka', color: '#fb8c00', dash: 'dashed', label: 'Kafka (event bus)' },
  { key: 'external', color: '#5e35b1', dash: 'dashed', label: 'External / SaaS' },
  { key: 'service', color: '#0097a7', dash: 'solid', label: 'Service edge (curated)' },
  { key: 'deploy', color: '#ef5350', dash: 'dotted', label: 'Deployment target' },
  { key: 'assets', color: '#546e7a', dash: 'dashed', label: 'Shared assets' },
  { key: 'content', color: '#8d6e63', dash: 'solid', label: 'Content source' },
]

// EDGE_TYPES with the design-system labels naming the configured package ("@acme/ui dependency").
export const edgeTypesFor = (config) => {
  const uiPackage = [...uiPackagesOf(config)][0]
  if (!uiPackage) return EDGE_TYPES
  const labelByKey = { dependency: `${uiPackage} dependency`, drift: `${uiPackage} version lag` }
  return EDGE_TYPES.map((type) => (labelByKey[type.key] ? { ...type, label: labelByKey[type.key] } : type))
}

// Edge id prefix -> edge type. 'bebe-' must be checked before 'be-'.
const EDGE_TYPE_BY_PREFIX = [
  ['dep-', 'dependency'],
  ['bebe-', 'bebe'],
  ['be-', 'febe'],
  ['dpl-', 'deploy'],
  ['ext-', 'external'],
  ['svc-', 'service'],
  ['asset-', 'assets'],
  ['content-', 'content'],
  ['link-k-', 'kafka'],
  ['link-r-', 'rest'],
]

export function edgeTypeOf(id = '', edge) {
  if (edge?.data?.drift) return 'drift'
  const match = EDGE_TYPE_BY_PREFIX.find(([prefix]) => id.startsWith(prefix))
  return match ? match[1] : 'other'
}

function chipsFor(repo) {
  const tooling = repo.toolingVersions || {}
  const chips = []
  if (tooling.react) chips.push('React ' + tooling.react)
  if (tooling.mui) chips.push('MUI ' + tooling.mui)
  if (tooling.buildTool) chips.push(tooling.buildTool.includes('CRA') ? 'CRA' : tooling.buildTool)
  return chips
}

// Cluster lanes, and the values of the Group filter (config.json `clusters`). Descriptor fields:
//   match:     owner-* topic prefixes routed to this cluster (first match wins)
//   color:     region outline color
//   defaultOn: whether the cluster is shown before any toggle
//   fallback:  the centre bucket for repos matching no cluster; clusterOf returns null for it
//   anchor/dir: layout hints. `anchor: -690` pins an x, `anchor: 'after:Backend'` sits just past
//              that lane, `dir: -1|1` is the way extra columns grow. Without hints, lanes
//              auto-distribute left to right in list order.
// The default is a single centre lane holding everything, so an unconfigured map still renders.
export const DEFAULT_CLUSTERS = [
  { label: 'Components', match: [], color: '#6a1b9a', defaultOn: true, fallback: true, center: true },
]
export const resolveClusters = (config) => nonEmptyOr(config?.clusters, DEFAULT_CLUSTERS)
const fallbackLabelOf = (clusters) => clusters.find((cluster) => cluster.fallback)?.label ?? null

const startsWithAny = (prefixes, value) => (prefixes || []).some((prefix) => value.startsWith(prefix))

// An explicit `cluster-*` topic is resolved by label or by `match`, so a fork remapping
// `cluster-CSS` to "Frontend" still routes. The fallback cluster maps to null (the centre bucket).
function clusterOfOverride(override, clusters) {
  const cluster = clusters.find((c) => c.label === override || startsWithAny(c.match, override))
  if (cluster) return cluster.fallback ? null : cluster.label
  return override === fallbackLabelOf(clusters) ? null : override
}

export const clusterOfInv = (inv, clusters = DEFAULT_CLUSTERS) => {
  const override = inv?.cluster
  if (override) return clusterOfOverride(override, clusters)
  const owner = inv?.owner || ''
  const cluster = clusters.find((c) => !c.fallback && startsWithAny(c.match, owner))
  return cluster ? cluster.label : null
}
const clusterOf = (repo, clusters = DEFAULT_CLUSTERS) => clusterOfInv(repo.inventory, clusters)

// Open high/critical Dependabot alerts, or a latest CI run that didn't succeed. Shared by the card
// badge, the Details and table columns, and the At-risk filter.
export const isAtRisk = (health) => {
  if (!health) return false
  const severeAlerts = (health.alerts?.high || 0) + (health.alerts?.critical || 0)
  const ciFailed = !!health.ci?.conclusion && health.ci.conclusion !== 'success'
  return severeAlerts > 0 || ciFailed
}

// Facets: each dimension (group, status, health, hidden) is a Set of allowed values; an empty or
// absent Set means no constraint. Values OR within a dimension and AND across dimensions. The graph
// applies `group` per repo before building (so lanes wrap the survivors) and the rest after; the
// Table and Matrix apply all of them through matchInventory, so every view narrows the same way.
export const facetsActive = (facets) =>
  !!(facets && (facets.group?.size || facets.status?.size || facets.health?.size || facets.hidden?.size))

// Selecting every option must behave like selecting none. Otherwise ticking every status would
// drop the status-less nodes (event bus, deploy targets, externals) that an empty selection keeps.
export const coversAll = (set, options) =>
  !!(set && set.size) && options.length > 0 && options.every((option) => set.has(option))

// The graph's post-build status filter (group is already applied per repo).
export const matchStatus = (inv, facets) => !facets?.status?.size || (!!inv && facets.status.has(inv.status))

// Full row match for the Table and Matrix. `hidden` is keyed by lowercased inventory name.
export const matchInventory = (inv, facets, clusters = DEFAULT_CLUSTERS) => {
  if (!inv) return false
  if (facets?.group?.size) {
    const group = clusterOfInv(inv, clusters) || fallbackLabelOf(clusters)
    if (!facets.group.has(group)) return false
  }
  if (facets?.status?.size && !facets.status.has(inv.status)) return false
  if (facets?.health?.size && !(facets.health.has('at-risk') && isAtRisk(inv.health))) return false
  if (facets?.hidden?.size && facets.hidden.has(String(inv.name).toLowerCase())) return false
  return true
}

// Lane colors for data-derived groupings; team clusters carry their own curated colors.
const GROUP_PALETTE = [
  '#3949ab',
  '#00838f',
  '#558b2f',
  '#6a1b9a',
  '#c62828',
  '#ef6c00',
  '#00897b',
  '#5e35b1',
  '#827717',
  '#ad1457',
]
const OTHER_LANE_COLOR = '#9e9e9e'

// Keys starting with '_' in config.json are comments.
const isConfigComment = (key) => key.startsWith('_')

function platformByApplication(platforms) {
  const byApplication = new Map()
  for (const [platform, applications] of Object.entries(platforms)) {
    if (isConfigComment(platform)) continue
    for (const application of applications || []) byApplication.set(application, platform)
  }
  return byApplication
}

// Group by Application or Platform. This only changes which lane a card sits in: the team
// clusters remain the filter taxonomy. A component in several applications rides its first one's
// lane; unmapped ones go to 'Other', which is kept out of the fallback bucket so the package-column
// logic keeps its team meaning.
export const groupingFor = (data, groupBy) => {
  if (groupBy !== 'application' && groupBy !== 'platform') return null
  const platforms = data.config?.platforms || {}
  const platformOf = platformByApplication(platforms)
  const laneOf = (inv) => {
    const application = inv?.applications?.[0]
    if (!application) return null
    return groupBy === 'application' ? application : platformOf.get(application) || null
  }
  // Platform lanes follow config order; application lanes are alphabetical.
  const labels =
    groupBy === 'platform'
      ? Object.keys(platforms).filter((key) => !isConfigComment(key))
      : [...new Set((data.inventory || []).map(laneOf).filter(Boolean))].sort()
  const clusters = [
    ...labels.map((label, i) => ({ label, color: GROUP_PALETTE[i % GROUP_PALETTE.length] })),
    { label: 'Other', color: OTHER_LANE_COLOR },
    // Never receives members (memberOf falls back to 'Other'); it only anchors the centre.
    { label: 'Unassigned', fallback: true, center: true },
  ]
  return { clusters, memberOf: (inv) => laneOf(inv) || 'Other' }
}

// ---- graph building blocks --------------------------------------------------------------------

const MS_PER_DAY = 86400000
const DEFAULT_STALE_DAYS = 120
const KAFKA_NAME = 'Kafka'
const KAFKA_BUS_ID = 'bus:kafka'
const PACKAGE_SCOPE = /^@[^/]+\//
const UNKNOWN_TAG_COLOR = '#888'
// Resource, deploy and external nodes are dropped when nothing links to them.
const PRUNABLE_KINDS = ['backend', 'extsvc', 'storage', 'infra', 'external']

const isInScope = (repo) => repo.kind !== 'personal' && repo.inOrg !== false

const cardNode = (id, data) => ({ id, type: 'card', position: { x: 0, y: 0 }, data })

function createGraph() {
  const nodes = []
  const edges = []
  const ids = new Set()
  return {
    nodes,
    edges,
    has: (id) => ids.has(id),
    addNode(node) {
      if (ids.has(node.id)) return
      ids.add(node.id)
      nodes.push(node)
    },
    addEdge(edge) {
      edges.push(edge)
    },
  }
}

const inventoryKindOf = (entry) => {
  if (entry.type === 'Client') return 'client'
  return /third/i.test(entry.type) ? 'external' : 'component'
}

function inventoryCard(entry) {
  return cardNode('inv:' + entry.name, {
    title: entry.name,
    subtitle: entry.owner + (entry.abbr ? ' · ' + entry.abbr : ''),
    kind: inventoryKindOf(entry),
    inventory: entry,
    status: entry.status,
    chips: [],
  })
}

function indexInventory(entries) {
  const byRepo = new Map()
  const byName = new Map()
  for (const entry of entries || []) {
    if (entry.repoName) addToListMap(byRepo, entry.repoName, entry)
    byName.set(entry.name.toLowerCase(), entry)
  }
  return { byRepo, byName }
}

// null when no group is selected, or when every group is (both mean "no constraint").
function selectedGroups(facets, clusters) {
  const selection = facets?.group
  if (!selection || !(selection.size ?? selection.length)) return null
  const allGroups = clusters.map((cluster) => cluster.label)
  if (coversAll(selection, allGroups)) return null
  return new Set(selection)
}

function foldersOutsideGroups(repos, groups, clusters) {
  const hidden = new Set()
  if (!groups) return hidden
  const fallbackLabel = fallbackLabelOf(clusters)
  for (const repo of repos || []) {
    const group = clusterOf(repo, clusters) || fallbackLabel
    if (!groups.has(group)) hidden.add(repo.folder)
  }
  return hidden
}

function productTagger(config) {
  const tagByApplication = { ...config?.productTags }
  const colorByTag = { ...TAG_COLOR, ...config?.tagColors }
  return (repo) => {
    const applications = repo.inventory?.applications || []
    const tags = [
      ...new Set(applications.map((application) => tagByApplication[application]).filter(Boolean)),
    ]
    return tags.map((label) => ({ label, color: colorByTag[label] || UNKNOWN_TAG_COLOR }))
  }
}

// Staleness is measured against the data's generation date, not today.
function stalenessOf(data) {
  const asOf = data.generatedAt ? new Date(data.generatedAt).getTime() : Date.now()
  const configuredDays = Number(data.config?.staleDays)
  const staleAfterDays = configuredDays > 0 ? configuredDays : DEFAULT_STALE_DAYS
  const daysSinceCommit = (repo) =>
    repo.lastCommit ? Math.round((asOf - new Date(repo.lastCommit).getTime()) / MS_PER_DAY) : null
  const isStale = (repo) => {
    const days = daysSinceCommit(repo)
    return days != null && days > staleAfterDays
  }
  return { daysSinceCommit, isStale }
}

// Card badges for newly discovered repos and half-curated ones (missing owner, status or desc).
function curationFlagger(validation) {
  const newFolders = new Set(validation.newlyDiscovered || [])
  const incompleteFolders = new Set([
    ...(validation.uncuratedRepos || []),
    ...(validation.incompleteCuration || []).map((entry) => String(entry).split(' — ')[0]),
  ])
  return (folder) => {
    const flags = {}
    if (newFolders.has(folder)) flags.isNew = true
    if (incompleteFolders.has(folder)) flags.incomplete = true
    return flags
  }
}

// ---- backends ---------------------------------------------------------------------------------

const scanNamesOf = (scan) => [scan.folder, scan.repoName, scan.canonicalName].filter(Boolean)

// A scanned backend that no curated entry covers is added automatically, flagged needsCuration so
// the missing host and wiring show up in the Admin panel. Any of the scan's names (clone folder,
// remote basename, post-rename name) matching a curated `repo` counts as covered, so a stale-named
// clone doesn't spawn a duplicate.
function uncuratedBackends(scanned, curated) {
  const curatedRepos = new Set(curated.map((backend) => backend.repo).filter(Boolean))
  return scanned
    .filter((scan) => !scanNamesOf(scan).some((name) => curatedRepos.has(name)))
    .map((scan) => {
      const name = scan.canonicalName || scan.folder
      return {
        id: name,
        label: name,
        kind: 'backend',
        repo: name,
        repoName: scan.repoName,
        canonicalName: scan.canonicalName,
        host: null,
        derived: true,
        needsCuration: true,
      }
    })
}

// Integration rows whose two ends both resolve to (different) backends.
function backendToBackendLinks(integrations, backendIdOf) {
  const links = []
  for (const row of integrations || []) {
    const source = backendIdOf(row.source)
    const target = backendIdOf(row.target)
    if (source && target && source !== target) links.push({ source, target, row })
  }
  return links
}

// "Used by" in the Details panel. The id lets the panel navigate to the consumer's card.
function consumersByBackend(repos, feBe) {
  const consumers = new Map()
  for (const repo of repos) {
    for (const backendId of feBe[repo.folder] || []) {
      addToListMap(consumers, backendId, { id: nodeIdOf(repo), label: repo.displayName || repo.folder })
    }
  }
  return consumers
}

// "Talks to" in the Details panel, from integrations in either direction.
function partnersByBackend(links, backendsById) {
  const partners = new Map()
  const addPartner = (backendId, partnerId, name, channel) => {
    if (!partners.has(backendId)) partners.set(backendId, [])
    const list = partners.get(backendId)
    if (name && !list.some((partner) => partner.id === partnerId)) {
      list.push({ id: partnerId, name, channel: channel || null })
    }
  }
  for (const { source, target, row } of links) {
    addPartner(source, target, backendsById.get(target)?.label || row.target, row.channel)
    addPartner(target, source, backendsById.get(source)?.label || row.source, row.channel)
  }
  return partners
}

// Backend topology = the curated overlay (backend-extra.json) merged with the live backend scan.
function indexBackends(data, repos, inventory, topology) {
  const scanned = data.extras?.backends?.scanned || []
  const curated = topology.backends || []
  const list = [...curated, ...uncuratedBackends(scanned, curated)]
  const byId = new Map(list.map((backend) => [backend.id, backend]))

  const firstInventoryOfRepo = (repoName) => repoName && inventory.byRepo.get(repoName)?.[0]
  const inventoryOf = (backend) =>
    (backend.invAlias && inventory.byName.get(backend.invAlias.toLowerCase())) ||
    firstInventoryOfRepo(backend.repo) ||
    // the scanned GitHub name, for when the clone folder lags a rename
    firstInventoryOfRepo(backend.repoName) ||
    firstInventoryOfRepo(backend.canonicalName) ||
    null

  // Tooling and freshness attach even when the clone folder differs from the curated `repo`.
  const scanOf = (backend) => {
    const names = new Set([backend.repo, backend.repoName, backend.canonicalName].filter(Boolean))
    return scanned.find((scan) => scanNamesOf(scan).some((name) => names.has(name)))
  }

  // Integrations name backends by inventory or repo name, feBe wiring by id: accept any of them.
  const idByName = new Map()
  for (const backend of list) {
    const inv = inventoryOf(backend)
    const names = [
      backend.id,
      backend.repo,
      backend.repoName,
      backend.canonicalName,
      backend.label,
      backend.invAlias,
      inv?.name,
    ]
    for (const name of names.filter(Boolean)) idByName.set(String(name).toLowerCase(), backend.id)
  }
  const idOf = (name) => idByName.get(String(name).toLowerCase()) || null

  const links = backendToBackendLinks(data.integrations, idOf)
  return {
    list,
    byId,
    inventoryOf,
    scanOf,
    idOf,
    links,
    consumers: consumersByBackend(repos, topology.feBe),
    partners: partnersByBackend(links, byId),
  }
}

// Description and tooling come from the scan and the inventory entry, falling back to the curated
// values for repos that aren't cloned. Host and wiring are always curated.
function addBackendCard(ctx, id) {
  const { backends } = ctx
  const backend = backends.byId.get(id)
  if (!backend) return
  const inventory = backends.inventoryOf(backend)
  const scan = backends.scanOf(backend)
  const tooling = (scan?.tooling?.length ? scan.tooling : backend.tooling) || []
  ctx.graph.addNode(
    cardNode(id, {
      title: backend.label,
      subtitle: inventory?.description || backend.desc,
      kind: backend.kind,
      chips: tooling,
      resource: {
        ...backend,
        tooling,
        modules: scan?.modules || [],
        lastCommit: scan?.lastCommit,
        consumers: backends.consumers.get(id) || [],
        partners: backends.partners.get(id) || [],
      },
      inventory,
      status: inventory?.status || null,
      flags: backend.needsCuration ? { incomplete: true } : ctx.flagsFor(backend.repo),
    }),
  )
}

// ---- repo cards and dependency edges ----------------------------------------------------------

function addRepoCards(ctx) {
  const { staleness } = ctx
  for (const repo of ctx.repos) {
    ctx.graph.addNode(
      cardNode(nodeIdOf(repo), {
        // the inventory name, so the card matches the Table and Matrix
        title: repo.inventory?.name || repo.displayName || repo.folder,
        subtitle: repo.name || '',
        kind: repo.kind,
        chips: ctx.mode === 'dev' ? chipsFor(repo) : [],
        tags: ctx.tagsFor(repo),
        repo,
        inventory: repo.inventory || null,
        status: repo.inventory?.status || null,
        stale: staleness.isStale(repo),
        staleDays: staleness.daysSinceCommit(repo),
        flags: ctx.flagsFor(repo.folder),
      }),
    )
  }
}

const versionParts = (version) =>
  String(version || '')
    .replace(/^[\^~>=<\s]+/, '')
    .split(/[.\-+]/)
    .map((part) => parseInt(part, 10) || 0)

function compareVersions(a, b) {
  const partsA = versionParts(a)
  const partsB = versionParts(b)
  const length = Math.max(partsA.length, partsB.length)
  for (let i = 0; i < length; i++) {
    const difference = (partsA[i] || 0) - (partsB[i] || 0)
    if (difference !== 0) return difference
  }
  return 0
}

// "Latest" is the highest version any consumer references: the design-system repo's own
// package.json lags the published versions. It spans all in-scope repos, not the group-filtered
// ones, so hiding a cluster never re-colors the remaining drift edges.
function latestUiVersion(data, isUiPackage) {
  const versions = (data.repos || [])
    .filter(isInScope)
    .flatMap((repo) =>
      isUiPackage(repo.name)
        ? []
        : (repo.internalDeps || []).filter((dep) => isUiPackage(dep.name)).map((dep) => dep.version),
    )
  return versions.sort(compareVersions).slice(-1)[0] || null
}

// A package listed as both a prod and a dev dependency would collide on edge id, so keep one entry
// per name, preferring the prod one.
function uniqueDeps(deps) {
  const byName = new Map()
  for (const dep of deps || []) {
    const seen = byName.get(dep.name)
    if (!seen || (seen.dev && !dep.dev)) byName.set(dep.name, dep)
  }
  return [...byName.values()]
}

// A package can be curated under its short name; its cluster override places it (a cross-cutting
// lib marked Shared lands in the centre, not the package column).
function packageCard(id, packageName, inventory) {
  const shortName = packageName.replace(PACKAGE_SCOPE, '')
  const entry = inventory.byName.get(shortName.toLowerCase()) || null
  const subtitle = packageName.startsWith('@')
    ? packageName.slice(0, packageName.indexOf('/')) + ' pkg'
    : 'internal pkg'
  return cardNode(id, {
    title: shortName,
    subtitle,
    kind: 'package',
    inventory: entry,
    sharedPkg: entry?.cluster === 'Shared',
    cssPkg: entry?.cluster === 'CSS',
  })
}

// Point at the package's real card when one exists; otherwise draw a "pkg:" card for it.
function dependencyTarget(ctx, dep, isUi, cardIdByPackage) {
  if (isUi) return ctx.resolveRef('ui')
  const repoCardId = cardIdByPackage.get(dep.name)
  if (repoCardId) return repoCardId
  const id = 'pkg:' + dep.name
  ctx.graph.addNode(packageCard(id, dep.name, ctx.inventory))
  return id
}

function dependencyEdge({ sourceId, targetId, dep, isUi, behind, latestUi }) {
  return {
    id: `dep-${sourceId}-${targetId}`,
    source: sourceId,
    target: targetId,
    label: behind ? `${dep.version} ⚠` : dep.version,
    animated: isUi,
    data: { drift: !!behind, scdLatest: latestUi },
    style: {
      stroke: behind ? '#e53935' : '#7c4dff',
      strokeWidth: isUi ? 2 : 1,
      strokeDasharray: behind ? '6 3' : undefined,
    },
    labelStyle: { fontSize: 10, fill: behind ? '#c62828' : '#5e35b1' },
    labelBgStyle: { fill: behind ? '#ffebee' : '#ede7f6' },
  }
}

// Internal dependency edges: the design system and every other first-party package.
function addDependencyEdges(ctx) {
  const { graph, isUiPackage } = ctx
  const cardIdByPackage = new Map()
  for (const repo of ctx.repos) if (repo.name) cardIdByPackage.set(repo.name, nodeIdOf(repo))
  const latestUi = latestUiVersion(ctx.data, isUiPackage)

  for (const repo of ctx.repos) {
    const sourceId = nodeIdOf(repo)
    for (const dep of uniqueDeps(repo.internalDeps)) {
      const isUi = isUiPackage(dep.name)
      const targetId = dependencyTarget(ctx, dep, isUi, cardIdByPackage)
      // the design system yalc-links its own package during local dev
      if (targetId === sourceId) continue
      if (!graph.has(targetId)) continue
      const behind = isUi && latestUi && compareVersions(dep.version, latestUi) < 0
      graph.addEdge(dependencyEdge({ sourceId, targetId, dep, isUi, behind, latestUi }))
    }
  }
}

// ---- layers -----------------------------------------------------------------------------------

function addResourceLayer(ctx) {
  const { graph, backends } = ctx
  const { feBe } = ctx.topology
  const wanted = new Set()
  for (const repo of ctx.repos) for (const id of feBe[repo.folder] || []) wanted.add(id)
  for (const link of backends.links) {
    wanted.add(link.source)
    wanted.add(link.target)
  }
  for (const backend of backends.list) if (wanted.has(backend.id)) addBackendCard(ctx, backend.id)

  for (const repo of ctx.repos) {
    for (const backendId of feBe[repo.folder] || []) {
      if (!graph.has(backendId)) continue
      graph.addEdge({
        id: `be-${nodeIdOf(repo)}-${backendId}`,
        source: nodeIdOf(repo),
        target: backendId,
        style: { stroke: '#fb8c00', strokeWidth: 1, opacity: 0.4 },
      })
    }
  }
  addBackendToBackendEdges(ctx)
}

// One edge per backend pair. Unverified rows (seeded from a description) render finer and dimmer.
function addBackendToBackendEdges(ctx) {
  const { graph } = ctx
  const seenPairs = new Set()
  for (const { source, target, row } of ctx.backends.links) {
    const pair = source + '>' + target
    if (seenPairs.has(pair) || !graph.has(source) || !graph.has(target)) continue
    seenPairs.add(pair)
    const unverified = row.verified === false
    graph.addEdge({
      id: `bebe-${source}-${target}`,
      source,
      target,
      label: row.channel || undefined,
      data: row.channelFull ? { channelFull: row.channelFull } : undefined,
      style: {
        stroke: '#6d4c41',
        strokeDasharray: unverified ? '1 4' : '2 3',
        strokeWidth: 1,
        opacity: unverified ? 0.4 : 0.55,
      },
      labelStyle: { fontSize: 9, fill: '#4e342e' },
      labelBgStyle: { fill: '#efebe9' },
    })
  }
}

const deployEdge = (sourceId, targetId) => ({
  id: `dpl-${targetId}-${sourceId}`,
  source: sourceId,
  target: targetId,
  style: { stroke: '#ef5350', strokeDasharray: '2 2', strokeWidth: 1, opacity: 0.4 },
})

const deploymentTargetText = (repo) =>
  (repo.deployment || [])
    .flatMap((deployment) => deployment.target || [])
    .join(' ')
    .toLowerCase()

function addDeploymentLayer(ctx) {
  const { graph, backends } = ctx
  const targets = deployTargetsOf(ctx.data.config)
  for (const target of targets) {
    graph.addNode(cardNode(target.id, { title: target.label, subtitle: 'deploy target', kind: 'infra' }))
  }
  // Deploy-artifact backends are still backend nodes: the Resources layer decides whether they
  // render, so never resurrect one here while it is off.
  if (ctx.layers.backends) {
    for (const backend of backends.list) {
      if (backend.deployArtifact && !graph.has(backend.id)) addBackendCard(ctx, backend.id)
    }
  }

  const matchers = targets
    .filter((target) => target.match)
    .map((target) => ({ pattern: new RegExp(target.match, 'i'), id: target.id }))
  const ciTargetId = targets.find((target) => target.testsFallback)?.id
  for (const repo of ctx.repos) {
    const workflowTargets = deploymentTargetText(repo)
    for (const { pattern, id } of matchers) {
      if (pattern.test(workflowTargets)) graph.addEdge(deployEdge(nodeIdOf(repo), id))
    }
    if (!workflowTargets && repo.kind === 'tests' && ciTargetId) {
      graph.addEdge(deployEdge(nodeIdOf(repo), ciTargetId))
    }
  }
  for (const backend of backends.list) {
    if (backend.deployTarget && graph.has(backend.id)) {
      graph.addEdge(deployEdge(backend.id, backend.deployTarget))
    }
  }
}

function addExternalLayer(ctx) {
  const { graph } = ctx
  const linkToExternal = (sourceId, name) => {
    const externalId = 'ext:' + name
    graph.addNode(cardNode(externalId, { title: name, subtitle: 'external service', kind: 'external' }))
    graph.addEdge({
      id: `ext-${sourceId}-${name}`,
      source: sourceId,
      target: externalId,
      style: { stroke: '#5e35b1', strokeDasharray: '4 3', strokeWidth: 1, opacity: 0.5 },
    })
  }
  for (const repo of ctx.repos) {
    for (const external of repo.externals || []) linkToExternal(nodeIdOf(repo), external.name)
  }
  // Make sure the backend card exists so its external edges have a source.
  for (const [backendId, names] of Object.entries(ctx.topology.backendExternals)) {
    if (!names.length) continue
    if (!graph.has(backendId)) addBackendCard(ctx, backendId)
    for (const name of names) linkToExternal(backendId, name)
  }
}

// Curated node-to-node relationships that can't be derived (FE embeds, token feeds, backend to FE
// service calls). Drawn only when both ends are on the map, so the layers gate them naturally.
function addCuratedServiceEdges(ctx) {
  const { graph, backends } = ctx
  for (const { source: rawSource, target: rawTarget, label } of ctx.topology.serviceEdges) {
    const source = ctx.resolveRef(rawSource)
    const target = ctx.resolveRef(rawTarget)
    if (!source || !target || !graph.has(source) || !graph.has(target)) continue
    const touchesBackend = backends.byId.has(source) || backends.byId.has(target)
    graph.addEdge({
      id: `svc-${source}-${target}`,
      source,
      target,
      label: label || undefined,
      style: touchesBackend
        ? { stroke: '#6d4c41', strokeDasharray: '2 3', strokeWidth: 1.2, opacity: 0.6 }
        : { stroke: '#0097a7', strokeWidth: 1.6 },
      labelStyle: touchesBackend ? { fontSize: 10, fill: '#4e342e' } : { fontSize: 10, fill: '#00838f' },
      labelBgStyle: { fill: touchesBackend ? '#efebe9' : '#e0f7fa' },
    })
  }
}

function addAssetEdges(ctx) {
  const { graph } = ctx
  const { assetsSource } = ctx.topology
  for (const rawConsumer of ctx.topology.assetConsumers) {
    const consumer = ctx.resolveRef(rawConsumer)
    if (!graph.has(consumer) || !graph.has(assetsSource)) continue
    graph.addEdge({
      id: `asset-${consumer}`,
      source: consumer,
      target: assetsSource,
      style: { stroke: '#546e7a', strokeDasharray: '5 3', strokeWidth: 1.2, opacity: 0.6 },
    })
  }
}

// Repo-less content sources, drawn next to their parent card.
function addContentRepos(ctx) {
  const { graph } = ctx
  for (const content of ctx.topology.contentRepos) {
    const parent = ctx.resolveRef(content.parent)
    if (!content.id || !content.parent || !graph.has(parent)) continue
    graph.addNode(
      cardNode(content.id, {
        title: content.label || content.id,
        subtitle: content.subtitle || 'content',
        kind: 'content',
        parentId: parent,
      }),
    )
    graph.addEdge({
      id: `content-${parent}-${content.id}`,
      source: parent,
      target: content.id,
      label: content.edgeLabel || undefined,
      style: { stroke: '#8d6e63', strokeWidth: 1.4 },
      labelStyle: { fontSize: 10, fill: '#4e342e' },
      labelBgStyle: { fill: '#efebe9' },
    })
  }
}

// Every inventory component not already on the map, as an edge-less grid.
function addInventoryCatalog(ctx) {
  const { graph } = ctx
  const represented = new Set(
    graph.nodes.filter((node) => node.data?.inventory).map((node) => node.data.inventory.name),
  )
  for (const entry of ctx.data.inventory) {
    if (!represented.has(entry.name)) graph.addNode(inventoryCard(entry))
  }
}

function serviceLinkStyle(isKafka, unverified) {
  if (unverified) {
    return {
      stroke: isKafka ? '#fb8c00' : '#00838f',
      strokeDasharray: '1 4',
      strokeWidth: 1.2,
      opacity: 0.45,
    }
  }
  if (isKafka) return { stroke: '#fb8c00', strokeDasharray: '5 3', strokeWidth: 1.6 }
  return { stroke: '#00838f', strokeWidth: 1.6 }
}

function serviceLinkLabelColors(isKafka, unverified) {
  if (unverified) return { text: '#9aa3b5', background: '#f0f1f3' }
  if (isKafka) return { text: '#e65100', background: '#fff3e0' }
  return { text: '#00838f', background: '#e0f7fa' }
}

// Unverified links (seeded from a description, not confirmed from code) render faint and dotted
// with a ⚠ label, so they read as inferred rather than fact.
function serviceLinkEdge(source, target, row) {
  const isKafka = row.protocol === 'Kafka'
  const unverified = row.verified === false
  const text = isKafka ? row.channel || 'Kafka' : row.channel || ''
  const colors = serviceLinkLabelColors(isKafka, unverified)
  return {
    // A pair can talk both REST and Kafka, so the protocol is part of the id.
    id: `link-${isKafka ? 'k' : 'r'}-${source}-${target}`,
    source,
    target,
    label: (unverified ? '⚠ ' : '') + text || undefined,
    data: row.channelFull ? { channelFull: row.channelFull } : undefined,
    style: serviceLinkStyle(isKafka, unverified),
    labelStyle: { fontSize: 9, fill: colors.text },
    labelBgStyle: { fill: colors.background },
  }
}

// REST and Kafka links between inventory components. An endpoint that isn't on the map yet is
// materialized as an inventory card: turning this layer on must show the services a link touches
// even when the catalog layer is off. The Kafka bus is only added when an edge to it draws.
function addServiceLinks(ctx) {
  const { graph, inventory, backends } = ctx
  const nodeIdByInventoryName = new Map()
  for (const node of graph.nodes) {
    if (node.data?.inventory) nodeIdByInventoryName.set(node.data.inventory.name, node.id)
  }
  const inventoryEntryOf = (name) => inventory.byName.get(String(name).toLowerCase())
  const canResolve = (name) =>
    name === KAFKA_NAME || !!nodeIdByInventoryName.get(name) || !!inventoryEntryOf(name)
  const resolve = (name) => {
    if (name === KAFKA_NAME) {
      graph.addNode(cardNode(KAFKA_BUS_ID, { title: 'Kafka', subtitle: 'event bus', kind: 'bus' }))
      return KAFKA_BUS_ID
    }
    const existingId = nodeIdByInventoryName.get(name)
    if (existingId) return existingId
    const entry = inventoryEntryOf(name)
    if (!entry) return null
    const card = inventoryCard(entry)
    graph.addNode(card)
    nodeIdByInventoryName.set(entry.name, card.id)
    return card.id
  }

  for (const row of ctx.data.integrations) {
    // backend↔backend rows are drawn by the Resources layer
    if (backends.idOf(row.source) && backends.idOf(row.target)) continue
    // Check both ends first, so one resolvable side never materializes a card for an edge that
    // then can't draw.
    if (!canResolve(row.source) || !canResolve(row.target)) continue
    const source = resolve(row.source)
    const target = resolve(row.target)
    if (!source || !target || !graph.has(source) || !graph.has(target)) continue
    graph.addEdge(serviceLinkEdge(source, target, row))
  }
}

// ---- post-build filtering ---------------------------------------------------------------------

function withoutUnlinkedResources(nodes, edges) {
  const linked = new Set()
  for (const edge of edges) {
    linked.add(edge.source)
    linked.add(edge.target)
  }
  // catalog cards are edge-less by design
  return nodes.filter(
    (node) => node.id.startsWith('inv:') || !PRUNABLE_KINDS.includes(node.data.kind) || linked.has(node.id),
  )
}

function makeFloating(edge) {
  edge.type = 'floating'
  const color = edge.style?.stroke || '#888'
  edge.markerEnd = { type: MarkerType.ArrowClosed, color, width: 16, height: 16 }
}

// Facets remove nodes (not dim them) before layout, so region boxes wrap only the survivors.
function keepNodes(view, keep) {
  view.nodes = view.nodes.filter(keep)
  const keptIds = new Set(view.nodes.map((node) => node.id))
  view.edges = view.edges.filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target))
}

// The name a card is listed and hidden under in the Components filter.
const listedNameOf = (node) =>
  (node.data?.inventory?.name || node.data?.title || '').replace(/\s+/g, ' ').trim() || null

const sortedUnique = (values) => [...new Set(values.filter(Boolean))].sort()

// buildGraph(data, { layers, facets, mode, layout, groupBy, hiddenEdges }) →
//   { nodes, edges, facetOptions: { status, components }, edgeTypesPresent }
// facetOptions are taken before their own filter runs, so a picked option stays listed.
export function buildGraph(data, opts = {}) {
  const { facets = null, mode = 'dev', layout = {} } = opts
  const grouping = groupingFor(data, opts.groupBy)
  const hiddenEdgeTypes = opts.hiddenEdges instanceof Set ? opts.hiddenEdges : new Set(opts.hiddenEdges || [])
  const layers = { ...DEFAULT_LAYERS, ...opts.layers }
  const clusters = resolveClusters(data.config)
  const uiPackages = uiPackagesOf(data.config)

  const hiddenFolders = foldersOutsideGroups(data.repos, selectedGroups(facets, clusters), clusters)
  const repos = (data.repos || []).filter((repo) => isInScope(repo) && !hiddenFolders.has(repo.folder))

  // Curated references (serviceEdges, assetConsumers, contentRepos.parent) name repos by folder;
  // map them to the card's node id. Anything else (backend ids) passes through.
  const nodeIdByFolder = new Map(repos.map((repo) => [repo.folder, nodeIdOf(repo)]))
  const resolveRef = (ref) => nodeIdByFolder.get(ref) ?? ref

  const rawTopology = data.backendTopology || {}
  const topology = {
    backends: rawTopology.backends,
    feBe: rawTopology.feBe || {},
    backendExternals: rawTopology.backendExternals || {},
    assetConsumers: rawTopology.assetConsumers || [],
    assetsSource: rawTopology.assetsSource || null,
    serviceEdges: rawTopology.serviceEdges || [],
    contentRepos: rawTopology.contentRepos || [],
  }
  const inventory = indexInventory(data.inventory)

  const ctx = {
    data,
    mode,
    layers,
    repos,
    topology,
    inventory,
    resolveRef,
    graph: createGraph(),
    backends: indexBackends(data, repos, inventory, topology),
    isUiPackage: (name) => uiPackages.has(name),
    tagsFor: productTagger(data.config),
    staleness: stalenessOf(data),
    flagsFor: curationFlagger(data.validation || {}),
  }

  addRepoCards(ctx)
  addDependencyEdges(ctx)
  if (layers.backends) addResourceLayer(ctx)
  if (layers.deploy) addDeploymentLayer(ctx)
  if (layers.integrations) addExternalLayer(ctx)
  addCuratedServiceEdges(ctx)
  addAssetEdges(ctx)
  addContentRepos(ctx)
  if (layers.components && (data.inventory || []).length) addInventoryCatalog(ctx)
  if (layers.serviceLinks && (data.integrations || []).length) addServiceLinks(ctx)

  // Hidden arrow classes go before pruning and layout, so a node left edge-less by them is dropped
  // and the lanes reflow. The unfiltered list still decides which classes the Legend offers.
  const allEdges = ctx.graph.edges
  const edges = hiddenEdgeTypes.size
    ? allEdges.filter((edge) => !hiddenEdgeTypes.has(edgeTypeOf(edge.id, edge)))
    : allEdges
  const view = { nodes: withoutUnlinkedResources(ctx.graph.nodes, edges), edges }
  for (const edge of view.edges) makeFloating(edge)

  if (facets?.health?.size) {
    keepNodes(
      view,
      (node) =>
        node.data.kind === 'bus' ||
        isAtRisk(node.data.inventory?.health || node.data.repo?.inventory?.health),
    )
  }
  // Only statuses present on the current map, so ticking one always narrows a visible set.
  const statusOptions = sortedUnique(view.nodes.map((node) => node.data?.inventory?.status))
  // Nodes without inventory (the Kafka bus) have no status, so an active status filter drops them.
  if (facets?.status?.size && !coversAll(facets.status, statusOptions)) {
    keepNodes(view, (node) => matchStatus(node.data?.inventory, facets))
  }
  // Every card is listable and hideable, including context cards like deploy targets and the bus.
  const componentOptions = sortedUnique(view.nodes.map(listedNameOf))
  const hidden = facets?.hidden
  const allComponentKeys = componentOptions.map((option) => option.toLowerCase())
  if (hidden?.size && !coversAll(hidden, allComponentKeys)) {
    keepNodes(view, (node) => {
      const name = listedNameOf(node)
      return !name || !hidden.has(name.toLowerCase())
    })
  }

  // Tells clusterLayout a missing design-system hub was filtered out on purpose, not lost.
  const filtered = facetsActive(facets)
  const finalIds = new Set(view.nodes.map((node) => node.id))
  const edgeTypesPresent = [
    ...new Set(
      allEdges
        .filter((edge) => finalIds.has(edge.source) && finalIds.has(edge.target))
        .map((edge) => edgeTypeOf(edge.id, edge)),
    ),
  ].filter((type) => type !== 'other')
  return {
    ...clusterLayout(view.nodes, view.edges, layout, data.config, filtered, grouping),
    facetOptions: { status: statusOptions, components: componentOptions },
    edgeTypesPresent,
  }
}

// ---- layout -----------------------------------------------------------------------------------

// Card tile size: whole multiples of the 16px drag grid, matching .node-card CSS.
const NODE_W = 224
const NODE_H = 96
const ROW_GAP = 112
const COL_GAP = NODE_W + 64
const MAX_PER_COLUMN = 8
const LANE_GAP = 120
const FIRST_AUTO_LANE_X = 760
const AFTER_ANCHOR = 'after:'
const LOOSE_PACKAGES_DEFAULT_X = -690
const UNCLASSIFIED_X = -1520
const EXTERNALS_BOTTOM_Y = -430
const RESOURCES_Y = 470
const DEPLOYMENTS_Y = 690
const BUS_Y = 850
const CATALOG_TOP_Y = 980
const CATALOG_COLUMNS = 7
// sorts after any real layoutOrder index
const UNORDERED = 999
const RESOURCE_KINDS = ['backend', 'extsvc', 'storage']
const UNCLASSIFIABLE_KINDS = ['backend', 'extsvc', 'storage', 'infra', 'component', 'bus']

// Vertical order of app cards within a lane (config.json `layoutOrder`, by repo folder); anything
// not listed follows in data order.
const DEFAULT_LAYOUT_ORDER = []

// Admin-dragged positions (config.json `layout`). An old folder-keyed entry still positions a node
// whose id is now its serviceId.
function applyLayoutOverrides(nodes, layout) {
  if (!layout) return
  for (const node of nodes) {
    const override = layout[node.id] ?? layout[node.data?.repo?.folder]
    if (override && Number.isFinite(override.x) && Number.isFinite(override.y)) {
      node.position = { x: override.x, y: override.y }
    }
  }
}

// Structural region bands (not team clusters) with fixed colors. STRUCTURAL_REGIONS is the subset a
// curator can annotate in the Admin panel; 'Unclassified' is an internal catch-all.
export const STRUCTURAL_REGIONS = ['Resources', 'Deployments', 'Integrations', 'Inventory catalog']
const STRUCTURAL_REGION_COLOR = {
  Resources: '#ef6c00',
  Deployments: '#c62828',
  Integrations: '#5e35b1',
  'Inventory catalog': '#00897b',
  Unclassified: '#9e9e9e',
}

function stackColumn(nodes, centerX) {
  const height = (nodes.length - 1) * ROW_GAP
  nodes.forEach((node, i) => {
    node.position = { x: centerX - NODE_W / 2, y: i * ROW_GAP - height / 2 - NODE_H / 2 }
  })
}

// A vertical stack that wraps into balanced columns growing in `dir` (+1 right, -1 left). Returns
// the column count so neighbours can clear it.
function stackColumns(nodes, startX, dir) {
  if (!nodes.length) return 0
  const columns = Math.ceil(nodes.length / MAX_PER_COLUMN)
  // balanced: 16 nodes make 2 columns of 8, 9 make 5 + 4
  const perColumn = Math.ceil(nodes.length / columns)
  nodes.forEach((node, i) => {
    const column = Math.floor(i / perColumn)
    const row = i % perColumn
    const inColumn = Math.min(perColumn, nodes.length - column * perColumn)
    const height = (inColumn - 1) * ROW_GAP
    node.position = {
      x: startX + dir * column * COL_GAP - NODE_W / 2,
      y: row * ROW_GAP - height / 2 - NODE_H / 2,
    }
  })
  return columns
}

// Mean x of the cards pointing at a node.
function consumerMeanX(node, edges, nodesById) {
  const consumers = edges
    .filter((edge) => edge.target === node.id)
    .map((edge) => nodesById.get(edge.source))
    .filter(Boolean)
  if (!consumers.length) return 0
  return consumers.reduce((sum, consumer) => sum + consumer.position.x, 0) / consumers.length
}

const byConsumerX = (nodes, meanX) =>
  nodes.map((node) => ({ node, x: meanX(node) })).sort((a, b) => a.x - b.x)

// One row, each node under its consumers, then pushed right until nothing overlaps.
function placeUnderConsumers(nodes, y, meanX) {
  const minGap = NODE_W + 40
  let previousX = -Infinity
  for (const { node, x: consumerX } of byConsumerX(nodes, meanX)) {
    const x = Math.max(consumerX, previousX + minGap)
    previousX = x
    node.position = { x, y: y - NODE_H / 2 }
  }
}

// A compact grid centred on centerX, growing up from bottomY, so wide fan-outs don't sprawl into
// a single very wide row.
function placeGridAbove(nodes, { bottomY, columns, centerX }, meanX) {
  const gapX = NODE_W + 36
  const gapY = 96
  const ordered = byConsumerX(nodes, meanX).map((entry) => entry.node)
  const rows = Math.ceil(ordered.length / columns)
  ordered.forEach((node, i) => {
    const row = Math.floor(i / columns)
    const inRow = Math.min(columns, ordered.length - row * columns)
    const rowWidth = (inRow - 1) * gapX
    const column = i % columns
    node.position = {
      x: centerX - rowWidth / 2 + column * gapX - NODE_W / 2,
      y: bottomY - (rows - 1 - row) * gapY - NODE_H / 2,
    }
  })
}

// Edge-less inventory components, grouped by owner, in their own band below everything else.
function placeCatalog(components) {
  const gapX = NODE_W + 30
  const gapY = 104
  const ordered = [...components].sort(
    (a, b) =>
      (a.data.inventory?.owner || '').localeCompare(b.data.inventory?.owner || '') ||
      a.id.localeCompare(b.id),
  )
  ordered.forEach((node, i) => {
    const row = Math.floor(i / CATALOG_COLUMNS)
    const column = i % CATALOG_COLUMNS
    const inRow = Math.min(CATALOG_COLUMNS, ordered.length - row * CATALOG_COLUMNS)
    node.position = {
      x: -((inRow - 1) * gapX) / 2 + column * gapX - NODE_W / 2,
      y: CATALOG_TOP_Y + row * gapY - NODE_H / 2,
    }
  })
}

// A number is an absolute x; 'after:<label>' sits just past that lane; otherwise lanes
// auto-distribute left to right. Places each lane's members and records its anchor and width.
function layOutLanes(laneClusters, membersOf) {
  const anchorByLabel = new Map()
  const columnsByLabel = new Map()
  const membersByLabel = new Map()
  let nextAutoAnchor = FIRST_AUTO_LANE_X
  for (const cluster of laneClusters) {
    let anchor
    if (typeof cluster.anchor === 'number') {
      anchor = cluster.anchor
    } else if (typeof cluster.anchor === 'string' && cluster.anchor.startsWith(AFTER_ANCHOR)) {
      const previous = cluster.anchor.slice(AFTER_ANCHOR.length)
      anchor = (anchorByLabel.get(previous) ?? 0) + (columnsByLabel.get(previous) ?? 1) * COL_GAP + LANE_GAP
    } else {
      anchor = nextAutoAnchor
      nextAutoAnchor += COL_GAP * 2 + LANE_GAP
    }
    anchorByLabel.set(cluster.label, anchor)
    const members = membersOf(cluster.label)
    membersByLabel.set(cluster.label, members)
    columnsByLabel.set(cluster.label, stackColumns(members, anchor, cluster.dir ?? 1))
  }
  return { anchorByLabel, columnsByLabel, membersByLabel }
}

// Outlier-tolerant bounds per axis, so a card dragged far away doesn't balloon its cluster box:
// Tukey fences for sizeable clusters, a generous fixed reach for small ones.
function fence(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const count = sorted.length
  const median = count % 2 ? sorted[(count - 1) / 2] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2
  if (count < 5) return [median - 2200, median + 2200]
  const quantile = (p) => sorted[Math.floor((count - 1) * p)]
  const spread = Math.max(quantile(0.75) - quantile(0.25), 250)
  return [quantile(0.25) - spread * 2.5, quantile(0.75) + spread * 2.5]
}

// Members outside the fences still render; they just sit outside the box.
function coreMembers(members) {
  const [minX, maxX] = fence(members.map((member) => member.position.x))
  const [minY, maxY] = fence(members.map((member) => member.position.y))
  const core = members.filter(
    ({ position }) => position.x >= minX && position.x <= maxX && position.y >= minY && position.y <= maxY,
  )
  return core.length ? core : members
}

function boundsAround(members) {
  const xs = members.map((member) => member.position.x)
  const ys = members.map((member) => member.position.y)
  const minX = Math.min(...xs) - 34
  const maxX = Math.max(...xs) + NODE_W + 34
  const minY = Math.min(...ys) - 52
  const maxY = Math.max(...ys) + NODE_H + 30
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

// An admin move/resize of the region wins over the computed bounds.
function regionOverride(layout, label) {
  const override = layout?.['region-' + label]
  if (!override || !Number.isFinite(override.x) || !Number.isFinite(override.w)) return null
  return { x: override.x, y: override.y, w: override.w, h: override.h }
}

function regionNode(label, members, layout, colorByLabel) {
  const present = members.filter(Boolean)
  if (!present.length) return null
  const { x, y, w, h } = regionOverride(layout, label) || boundsAround(coreMembers(present))
  return {
    id: 'region-' + label,
    type: 'region',
    draggable: false,
    selectable: false,
    focusable: false,
    zIndex: -10,
    position: { x, y },
    style: { width: w, height: h },
    data: { label, color: colorByLabel[label] || '#888', w, h, members: present.map((member) => member.id) },
  }
}

// Team-cluster lanes left to right, the fallback cluster in the centre, externals above, resources
// and deploy targets in rows below, the inventory catalog at the bottom. `grouping` (groupingFor)
// swaps the lane taxonomy for a derived one.
function clusterLayout(nodes, edges, layout, config = {}, filtered = false, grouping = null) {
  const clusters = grouping?.clusters || resolveClusters(config)
  const laneOf = (repo) => (grouping ? grouping.memberOf(repo?.inventory) : clusterOf(repo, clusters))
  const fallbackLabel = fallbackLabelOf(clusters)
  const colorByLabel = {
    ...STRUCTURAL_REGION_COLOR,
    ...Object.fromEntries(clusters.filter((c) => c.color).map((c) => [c.label, c.color])),
    ...config?.clusterColors,
  }

  // The lanes don't need the design-system hub, but a missing hub is the tell-tale of a lagging
  // data source that dropped much else, so flatten to dagre and warn. Not when a filter removed it
  // on purpose, and not when no design system is configured.
  const hubFolders = uiHubFoldersOf(config)
  const expectsHub = uiPackagesOf(config).size > 0
  const hub = nodes.find(
    (node) => hubFolders.includes(node.id) || hubFolders.includes(node.data?.repo?.folder),
  )
  if (expectsHub && !hub && !filtered) {
    console.warn(
      `clusterLayout: design-system hub node not found (looked for ${hubFolders.join('/')}) — falling back to dagre layout`,
    )
    return dagreLayout(nodes, edges, layout)
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const meanX = (node) => consumerMeanX(node, edges, nodesById)
  const ofKind = (...kinds) => nodes.filter((node) => kinds.includes(node.data.kind))

  // A package's inventory `cluster` routes it into that lane; fallback-cluster packages go to the
  // centre; packages with no cluster form a loose column left of the leftmost lane.
  const packages = ofKind('package')
  const packageCluster = (pkg) => pkg.data.inventory?.cluster || null
  const centrePackages = packages.filter((pkg) => packageCluster(pkg) === fallbackLabel)
  const loosePackages = packages.filter((pkg) => !packageCluster(pkg))
  const resources = ofKind(...RESOURCE_KINDS)
  const deployTargets = ofKind('infra')

  const layoutOrder = nonEmptyOr(config?.layoutOrder, DEFAULT_LAYOUT_ORDER)
  const orderHint = (node) => {
    const index = layoutOrder.indexOf(node.data.repo?.folder ?? node.id)
    return index < 0 ? UNORDERED : index
  }
  const membersOf = (label) => {
    const apps = nodes
      .filter((node) => node.data.repo && laneOf(node.data.repo) === label)
      .sort((a, b) => orderHint(a) - orderHint(b))
    // content repos follow their parent card's lane
    const content = nodes.filter(
      (node) =>
        node.data.kind === 'content' &&
        node.data.parentId &&
        laneOf(nodesById.get(node.data.parentId)?.data?.repo || {}) === label,
    )
    const lanePackages = packages.filter((pkg) => packageCluster(pkg) === label)
    return [...apps, ...content, ...lanePackages]
  }

  const laneClusters = clusters.filter((cluster) => !cluster.fallback)
  const { anchorByLabel, columnsByLabel, membersByLabel } = layOutLanes(laneClusters, membersOf)
  const leftmostLabel = laneClusters.length
    ? laneClusters.reduce((leftmost, cluster) =>
        anchorByLabel.get(cluster.label) < anchorByLabel.get(leftmost.label) ? cluster : leftmost,
      ).label
    : null
  const loosePackagesX = leftmostLabel
    ? anchorByLabel.get(leftmostLabel) - (columnsByLabel.get(leftmostLabel) || 0) * COL_GAP - 40
    : LOOSE_PACKAGES_DEFAULT_X
  stackColumn(loosePackages, loosePackagesX)

  // Suite-wide repos and packages in the centre column; empty (and boxless) when there are none.
  const centreNodes = [
    ...nodes.filter((node) => node.data.repo?.inventory?.cluster === fallbackLabel),
    ...centrePackages,
  ]
  centreNodes.forEach((node, i) => {
    node.position = { x: -40 - NODE_W / 2, y: -160 + i * 104 - NODE_H / 2 }
  })

  // Externals in a grid above the main row, clear of its tallest box.
  const externals = ofKind('external')
  if (externals.length)
    placeGridAbove(externals, { bottomY: EXTERNALS_BOTTOM_Y, columns: 5, centerX: 0 }, meanX)

  // Anything left over, e.g. a repo newly added since the clusters were configured.
  const laneNodes = laneClusters.flatMap((cluster) => membersByLabel.get(cluster.label) || [])
  const placedIds = new Set(
    [...laneNodes, ...loosePackages, ...centreNodes, ...externals].map((node) => node.id),
  )
  const unclassified = nodes.filter(
    (node) =>
      !placedIds.has(node.id) &&
      !node.id.startsWith('inv:') &&
      !node.id.startsWith('bus:') &&
      !UNCLASSIFIABLE_KINDS.includes(node.data.kind),
  )
  if (unclassified.length) stackColumn(unclassified, UNCLASSIFIED_X)
  if (resources.length) placeUnderConsumers(resources, RESOURCES_Y, meanX)
  if (deployTargets.length) placeUnderConsumers(deployTargets, DEPLOYMENTS_Y, meanX)

  // The bus sits centred just above the catalog band.
  const kafkaBus = nodesById.get(KAFKA_BUS_ID)
  if (kafkaBus) kafkaBus.position = { x: -NODE_W / 2, y: BUS_Y - NODE_H / 2 }
  const components = nodes.filter((node) => node.id.startsWith('inv:'))
  if (components.length) placeCatalog(components)

  // Before the boxes are measured, so boxes wrap moved cards.
  applyLayoutOverrides(nodes, layout)

  const regions = []
  const addRegion = (label, members) => {
    const region = regionNode(label, members, layout, colorByLabel)
    if (region) regions.push(region)
  }
  // The leftmost lane's box also wraps the loose package column.
  for (const cluster of laneClusters) {
    const loose = cluster.label === leftmostLabel ? loosePackages : []
    addRegion(cluster.label, [...loose, ...(membersByLabel.get(cluster.label) || [])])
  }
  addRegion(fallbackLabel, centreNodes)
  if (externals.length) addRegion('Integrations', externals)
  if (unclassified.length) addRegion('Unclassified', unclassified)
  if (resources.length) addRegion('Resources', resources)
  if (deployTargets.length) addRegion('Deployments', deployTargets)
  if (components.length) addRegion('Inventory catalog', components)

  return { nodes: [...regions, ...nodes], edges }
}

function dagreLayout(nodes, edges, layout) {
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 120, marginx: 20, marginy: 20 })
  for (const node of nodes) graph.setNode(node.id, { width: NODE_W, height: NODE_H })
  for (const edge of edges) graph.setEdge(edge.source, edge.target)
  dagre.layout(graph)
  for (const node of nodes) {
    const { x, y } = graph.node(node.id)
    node.position = { x: x - NODE_W / 2, y: y - NODE_H / 2 }
  }
  applyLayoutOverrides(nodes, layout)
  return { nodes, edges }
}
