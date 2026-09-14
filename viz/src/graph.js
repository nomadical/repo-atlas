import dagre from '@dagrejs/dagre'
import { MarkerType } from '@xyflow/react'

// The design-system package names that all resolve to the single `ui` hub card, from config.json
// `uiPackages`. List every name consumers might pin — a package mid-rename is referenced under both
// its old and new name, and both should collapse onto the one hub. Empty => no hub card is drawn.
// Kept in sync with UI_PACKAGES in scripts/assemble.mjs.
export const DEFAULT_UI_PACKAGES = []
export const uiPackagesOf = (config) => new Set(Array.isArray(config?.uiPackages) ? config.uiPackages : DEFAULT_UI_PACKAGES)

// Repo folder(s) the design-system hub card can appear under (config.json `uiHubFolders`).
export const uiHubFoldersOf = (config) => (Array.isArray(config?.uiHubFolders) && config.uiHubFolders.length ? config.uiHubFolders : ['ui'])

// Component node identity: the inventory serviceId (stable across repo-folder renames), falling
// back to the repo folder when the pipeline hasn't emitted a serviceId yet — so the graph is
// byte-invariant against data that predates it. The folder stays a PERMANENT back-compat alias for
// old ?sel= links / saved views / config.json layout keys, resolved at read (see applyOverrides and
// App.jsx's matchSelNode). backend-extra.json feBe stays folder-keyed and is resolved at read too.
export const nodeIdOf = (r) => r.serviceId || r.folder

export const KIND = {
  client: { label: 'Client', color: '#1e88e5' },
  library: { label: 'Library', color: '#7c4dff' },
  service: { label: 'Service', color: '#00897b' },
  // `backend`/`extsvc` are topology kinds (layout, pruning + edge routing still key off them), but to
  // a curator they're just their Component-Inventory Type: a backend IS a Service, an external API IS
  // a Third-Party Service. So they share the canonical Type's label + color on every user-facing
  // surface (cards, Details, minimap, legend). See KIND_ALIAS / canonKind for the by-kind aggregations.
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
  // per-client drill-down view (clientGraph.js): screen → endpoint → backend (blue → teal → orange,
  // backend reusing the map's Backend service color so the tiers read as one trace)
  screen: { label: 'Screen', color: '#1e88e5' },
  endpoint: { label: 'Endpoint', color: '#00838f' },
}

// Collapse the topology kinds onto the single Component-Inventory Type they represent. Used wherever
// nodes are GROUPED/counted by kind (legend, region breakdown) so a backend and a service don't show
// up as two separate "Service" buckets. Direct KIND[kind] lookups already read the shared label/color.
export const KIND_ALIAS = { backend: 'service', extsvc: 'external' }
export const canonKind = (k) => KIND_ALIAS[k] || k

// Cross-cutting product tags — derived from each component's applications (GitHub app-* topics),
// so one chip can span several applications ("everything in the billing line"). Both maps are
// config.json `productTags` (application → tag) and `tagColors` (tag → color); with none set no
// chips render. The merge + tagsFor live inside buildGraph (which has data.config).
export const TAG_COLOR = {}
const PRODUCT_TAGS = {}

// Backend / service / storage topology is not hardcoded here. The curated overlay (hosts, kind,
// FE→BE wiring, backend→external SaaS, deploy targets, service edges, content repos) lives in
// backend-extra.json and arrives as data.backendTopology; backend→backend edges live in
// integrations.csv. buildGraph merges the overlay with the live backend scan
// (data.extras.backends.scanned) so a newly-cloned backend appears automatically — see the
// `topo`/`BE_NODES` block inside buildGraph. Editable via the in-app Admin panel.

// Deploy-target nodes (the Deployments layer) + how a repo's workflow target text routes to them
// (`match` is a case-insensitive regex over the deployment target strings; `testsFallback` marks
// the node test-harness repos without a deploy target link to). A fork overrides the whole list
// via config.json `deployTargets`.
const DEFAULT_DEPLOY_TARGETS = [
  { id: 'inf-blob', label: 'Azure Storage $web\n+ Front Door/CDN', match: 'blob|\\$web|front door' },
  { id: 'inf-acr', label: 'Azure Container Registry\n+ docker-compose', match: 'container' },
  { id: 'inf-ci', label: 'GitHub Actions\n(CI)', testsFallback: true },
]
const deployTargetsOf = (config) => (Array.isArray(config?.deployTargets) && config.deployTargets.length ? config.deployTargets : DEFAULT_DEPLOY_TARGETS)

// Detail-layer registry — the single definition the toolbar, the URL codec and buildGraph share.
// Layers are ADDITIVE: each one draws an extra class of node. `param` is the URL query key
// (stable — shared/embedded links depend on it); `default` is the state before any toggle.
export const LAYERS = [
  { key: 'backends', param: 'be', label: 'Resources', default: true },
  { key: 'integrations', param: 'int', label: 'Integrations', default: false },
  { key: 'deploy', param: 'dpl', label: 'Deployments', default: true },
  // NB: not "Components" — everything on the map is a component. This layer draws the REST of the
  // Component Inventory (entries not already wired onto the map) as a catalog grid. `param`/`key` stay
  // stable so existing shared/embedded links keep working.
  { key: 'components', param: 'comp', label: 'Inventory catalog', default: false },
  { key: 'serviceLinks', param: 'links', label: 'Service links', default: false },
]
export const DEFAULT_LAYERS = Object.fromEntries(LAYERS.map((l) => [l.key, l.default]))

// Edge-type registry — the arrow classes a user can show/hide on the graph. `key` is the stable id
// used by the hide-by-type filter (and the `hedge` URL param); color/dash mirror the canvas arrow
// style so the Legend swatch matches what's drawn. Only types actually present on the current map
// are offered as toggles (see buildGraph's edgeTypesPresent + Legend).
export const EDGE_TYPES = [
  { key: 'dependency', color: '#7c4dff', dash: 'solid', label: '@framework/ui dependency' },
  // Red variant of a dependency edge: the consumer references a @framework/ui version behind the
  // highest one in use (see buildGraph `behind`). A distinct type so it reads in the legend and can be
  // toggled on its own; classified off edge.data.drift, not the id (it shares the dep- id prefix).
  { key: 'drift', color: '#e53935', dash: 'dashed', label: '@framework/ui version lag' },
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

// Classify a built edge by its id prefix (see the push sites in buildGraph). NOTE: backend↔backend
// ids ('bebe-') must be tested before FE→resource ('be-') would be, but the distinct prefixes make
// the order incidental here; kept explicit for clarity.
export function edgeTypeOf(id = '', edge) {
  if (edge?.data?.drift) return 'drift' // red version-lag variant of a dependency edge
  if (id.startsWith('dep-')) return 'dependency'
  if (id.startsWith('bebe-')) return 'bebe'
  if (id.startsWith('be-')) return 'febe'
  if (id.startsWith('dpl-')) return 'deploy'
  if (id.startsWith('ext-')) return 'external'
  if (id.startsWith('svc-')) return 'service'
  if (id.startsWith('asset-')) return 'assets'
  if (id.startsWith('content-')) return 'content'
  if (id.startsWith('link-k-')) return 'kafka'
  if (id.startsWith('link-r-')) return 'rest'
  return 'other'
}

function chipsFor(r) {
  const t = r.toolingVersions || {}
  const chips = []
  if (t.react) chips.push('React ' + t.react)
  if (t.mui) chips.push('MUI ' + t.mui)
  if (t.buildTool) chips.push(t.buildTool.includes('CRA') ? 'CRA' : t.buildTool)
  return chips
}

// Cluster taxonomy — the lanes the graph draws and the Group filter's values. Define yours in
// config.json `clusters`; DEFAULT_CLUSTERS is the safety net when none are configured: a single
// centre lane holding everything, so an unconfigured map still renders. Descriptor fields:
//   match:     owner-* topic prefixes routed to this cluster (first match wins)
//   color:     region outline color
//   defaultOn: initial filter state (whether the cluster is shown before any toggle)
//   fallback:  the bucket for repos matching no cluster (and explicit `cluster-<fallback>`); the
//              centre column. clusterOf returns null for it, so "unassigned" reads as no cluster.
//   anchor/dir/center/after: layout hints, in graph units. Pin a lane with `anchor: -690` (left of
//              centre) or `anchor: 'after:Backend'` (just past that lane), `dir: -1|1` for which way
//              it grows. Omit them and lanes auto-distribute left→right in list order — a good
//              starting point; add hints only once you want a specific arrangement (clusterLayout).
export const DEFAULT_CLUSTERS = [{ label: 'Components', match: [], color: '#6a1b9a', defaultOn: true, fallback: true, center: true }]
export const resolveClusters = (config) => (Array.isArray(config?.clusters) && config.clusters.length ? config.clusters : DEFAULT_CLUSTERS)
const fallbackLabelOf = (clusters) => clusters.find((c) => c.fallback)?.label ?? null

// Cluster of an inventory entry: an explicit `cluster-*` topic wins — resolved against the cluster
// list by label or `match` (so a fork remapping `cluster-CSS` → "Frontend" still routes correctly),
// with the fallback cluster mapping to null (the centre bucket, preserving legacy "Shared =
// unassigned"). Otherwise the first cluster whose `match` prefixes the owner team; otherwise null.
const clusterMatching = (clusters, value) => clusters.find((c) => c.label === value || (c.match || []).some((p) => value.startsWith(p)))
export const clusterOfInv = (inv, clusters = DEFAULT_CLUSTERS) => {
  const override = inv?.cluster
  if (override) {
    const c = clusterMatching(clusters, override)
    if (c) return c.fallback ? null : c.label
    return override === fallbackLabelOf(clusters) ? null : override
  }
  const owner = inv?.owner || ''
  const hit = clusters.find((c) => !c.fallback && (c.match || []).some((p) => owner.startsWith(p)))
  return hit ? hit.label : null
}
const clusterOf = (r, clusters = DEFAULT_CLUSTERS) => clusterOfInv(r.inventory, clusters)

// A repo is "at risk" if it has open high/critical Dependabot alerts or a non-green latest CI run.
// Shared by the card badge (CardNode), the Details/table columns, and the At-risk filter.
export const isAtRisk = (health) =>
  !!health && ((health.alerts?.high || 0) + (health.alerts?.critical || 0) > 0 || (!!health.ci?.conclusion && health.ci.conclusion !== 'success'))

// Faceted filters. Each dimension is a Set of allowed values: an empty (or absent) Set imposes no
// constraint. Within a dimension the values OR together; across dimensions they AND. Dimensions:
//   group  — the repo's team cluster (ISS / CSS / IoT / Shared)
//   status — lifecycle stage (Current / Planned / Sunsetting / Removed)
//   health — 'at-risk' (open high/critical alerts or a failing latest CI run)
// The graph applies `group` per-repo inside buildGraph (so cluster lanes and region boxes wrap the
// survivors) and `status`/`health` as a post-build node filter; the Table / Matrix apply ALL of
// them to inventory rows via matchInventory, so every view narrows by the same rules.
export const facetsActive = (f) => !!(f && (f.group?.size || f.status?.size || f.health?.size || f.hidden?.size))
// A multi-select facet whose selection covers EVERY available option imposes no constraint — so
// "select all" behaves identically to "select none" (both = show everything). Without this, ticking
// every status drops status-less nodes (the event bus, deploy targets, external services) that an
// empty selection keeps, so all-selected ≠ none-selected. Keeps each filter kind symmetric.
export const coversAll = (set, options) => !!(set && set.size) && options.length > 0 && options.every((o) => set.has(o))
// status-only match for the graph's post-build node filter (group is already applied per-repo).
export const matchStatus = (inv, f) => !f?.status?.size || (!!inv && f.status.has(inv.status))
// full row match (group + status + health) for the Table / Matrix, which filter inventory entries.
export const matchInventory = (inv, f, clusters = DEFAULT_CLUSTERS) => {
  if (!inv) return false
  if (f?.group?.size) {
    const g = clusterOfInv(inv, clusters) || fallbackLabelOf(clusters)
    if (!f.group.has(g)) return false
  }
  if (f?.status?.size && !f.status.has(inv.status)) return false
  if (f?.health?.size && !(f.health.has('at-risk') && isAtRisk(inv.health))) return false
  // hidden = per-component show/hide list, keyed by lowercased inventory name (Table/Matrix rows)
  if (f?.hidden?.size && f.hidden.has(String(inv.name).toLowerCase())) return false
  return true
}

// buildGraph(data, { layers, facets, mode, layout }) →
//   { nodes, edges, facetOptions: { status } }
//
//   layers — { backends, integrations, deploy, components, serviceLinks } booleans (see LAYERS)
//   facets — { group, status, health } Sets; an empty/absent Set imposes no constraint.
//            `group` is applied per-repo BEFORE the node build (cluster lanes wrap survivors);
//            `health` then `status` are post-build node filters. facetOptions.status reports the
//            statuses present before the status filter ran, so the Filters menu can scope its
//            options to the current view without a second build.
// Lane colors for DERIVED groupings (Group by: Application / Platform) — the team clusters carry
// their own curated colors, but application/platform lanes are data-derived, so they cycle this.
const GROUP_PALETTE = ['#3949ab', '#00838f', '#558b2f', '#6a1b9a', '#c62828', '#ef6c00', '#00897b', '#5e35b1', '#827717', '#ad1457']

// Alternate lane grouping (Group by: Team | Application | Platform). Grouping only changes which
// LANE a card is laid out in — the team clusters stay the filtering taxonomy (facets.group), so
// you can group by platform while still filtering by team. Derived lanes carry no anchors, so
// clusterLayout auto-distributes them left→right; components in several applications ride their
// FIRST application's lane; anything unmapped lands in a plain 'Other' lane (kept out of the
// fallback/centre bucket so package-column logic keeps its team semantics).
export const groupingFor = (data, groupBy) => {
  if (groupBy !== 'application' && groupBy !== 'platform') return null
  const appToPlat = {}
  for (const [plat, apps] of Object.entries(data.config?.platforms || {})) {
    if (plat.startsWith('_')) continue
    for (const a of apps || []) appToPlat[a] = plat
  }
  const labelOfInv = (inv) => {
    const app = inv?.applications?.[0]
    if (!app) return null
    return groupBy === 'application' ? app : appToPlat[app] || null
  }
  // platform lanes follow config.platforms order; application lanes are alphabetical
  const labels =
    groupBy === 'platform'
      ? Object.keys(data.config?.platforms || {}).filter((k) => !k.startsWith('_'))
      : [...new Set((data.inventory || []).map(labelOfInv).filter(Boolean))].sort()
  const clusters = [
    ...labels.map((label, i) => ({ label, color: GROUP_PALETTE[i % GROUP_PALETTE.length] })),
    { label: 'Other', color: '#9e9e9e' },
    { label: 'Unassigned', fallback: true, center: true }, // never receives members — see memberOf
  ]
  return { clusters, memberOf: (inv) => labelOfInv(inv) || 'Other' }
}

export function buildGraph(data, opts = {}) {
  const { facets = null, mode = 'dev', layout = {} } = opts
  const grouping = groupingFor(data, opts.groupBy)
  // Arrow classes the user has hidden (by edge-type key). Accepts a Set or array; empty = show all.
  const hiddenEdges = opts.hiddenEdges instanceof Set ? opts.hiddenEdges : new Set(opts.hiddenEdges || [])
  const layers = { ...DEFAULT_LAYERS, ...opts.layers }
  const clusters = resolveClusters(data.config)
  const fallbackLabel = fallbackLabelOf(clusters)
  // Design-system package names resolving to the `ui` hub card (config-overridable).
  const uiPkgs = uiPackagesOf(data.config)
  const isUiPkg = (name) => uiPkgs.has(name)
  // null/empty group facet = no constraint (every group shown). A non-empty set is a positive
  // selection: a repo shows only if its cluster is ticked (OR within the group dimension).
  const groupSel = facets?.group
  // ...unless every cluster is ticked, which (like an empty set) means "no group constraint".
  const groupOptions = clusters.map((c) => c.label)
  const activeSet = groupSel && (groupSel.size ?? groupSel.length) && !coversAll(groupSel, groupOptions) ? new Set(groupSel) : null
  // Product tag chips shown on the cards (AT / CI); no longer a filter dimension — a repo's tags are
  // the unique product tags across the applications its inventory entry serves.
  const productTags = { ...PRODUCT_TAGS, ...data.config?.productTags }
  const tagColor = { ...TAG_COLOR, ...data.config?.tagColors } // chip color per tag; unknowns → grey
  const tagsFor = (r) => [...new Set((r.inventory?.applications || []).map((a) => productTags[a]).filter(Boolean))]
  const tagObjs = (r) => tagsFor(r).map((label) => ({ label, color: tagColor[label] || '#888' }))
  // Group filter (team cluster): applied per-repo before node build so cluster lanes and region boxes
  // wrap exactly the survivors. Status is a separate post-build facet (see below).
  const hidden = new Set()
  if (activeSet)
    for (const r of data.repos || []) {
      const g = clusterOf(r, clusters) || fallbackLabel // null cluster = fallback bucket
      if (!activeSet.has(g)) hidden.add(r.folder)
    }
  // in-org repos only — repos outside the configured org are out of scope; honor the group filter
  const repos = (data.repos || []).filter((r) => r.kind !== 'personal' && r.inOrg !== false && !hidden.has(r.folder))
  // folder -> card node id, for aliasing curated references authored by repo FOLDER (serviceEdges,
  // assetConsumers, contentRepos.parent, the isScd hub target) to the card's real node id once it
  // is a serviceId. Byte-invariant: without a serviceId nodeIdOf(r)===r.folder, so resolveRef is the
  // identity and non-folder refs (backend ids) pass through unchanged.
  const nodeIdByFolder = Object.fromEntries(repos.map((r) => [r.folder, nodeIdOf(r)]))
  const resolveRef = (x) => nodeIdByFolder[x] ?? x
  let nodes = []
  let edges = []
  const ids = new Set()
  const add = (n) => {
    if (!ids.has(n.id)) {
      ids.add(n.id)
      nodes.push(n)
    }
  }

  // Component Inventory lookups (embedded in the data). Match backend nodes by their GitHub repo
  // basename; a couple of aliases cover components whose repo column is empty/differs.
  const invByRepo = {},
    invByName = {}
  for (const e of data.inventory || []) {
    if (e.repoName) (invByRepo[e.repoName] = invByRepo[e.repoName] || []).push(e)
    invByName[e.name.toLowerCase()] = e
  }
  const invForBackend = (be) =>
    (be.invAlias && invByName[be.invAlias.toLowerCase()]) ||
    (be.repo && (invByRepo[be.repo] || [])[0]) ||
    (be.repoName && (invByRepo[be.repoName] || [])[0]) || // scanned GitHub name when the folder lags a rename
    (be.canonicalName && (invByRepo[be.canonicalName] || [])[0]) ||
    null

  // Backend topology = curated overlay (backend-extra.json → data.backendTopology) MERGED with the
  // live backend scan. A scanned backend not covered by the overlay is auto-added (kind 'backend',
  // no host) so a newly-cloned backend appears without a source edit — flagged needsCuration so the
  // gap (host/wiring) shows up in the Admin panel. Edge-less backend nodes are pruned at the end,
  // so auto-derived backends only render once something (FE→BE or an integration) wires them.
  const topo = data.backendTopology || {}
  const feBe = topo.feBe || {}
  const backendExternals = topo.backendExternals || {}
  const assetConsumers = topo.assetConsumers || []
  const assetsSource = topo.assetsSource || null // the shared asset-bucket card the consumers point at (backend-extra.json 'assetsSource')
  const serviceEdges = topo.serviceEdges || [] // curated node↔node service relationships
  const contentRepos = topo.contentRepos || [] // repo-less content sources drawn next to their parent
  const scannedBE = data.extras?.backends?.scanned || []
  const curatedBE = topo.backends || []
  const curatedRepos = new Set(curatedBE.map((b) => b.repo).filter(Boolean))
  // a scanned repo is "the same as" a curated backend if any of its names (clone folder, remote
  // basename, or canonical post-rename name) matches a curated `repo` — so a stale-named clone
  // (pharma-backend) doesn't spawn a duplicate of the curated node (repo intervention-backend).
  const scanNames = (s) => [s.folder, s.repoName, s.canonicalName].filter(Boolean)
  const derivedBE = scannedBE
    .filter((s) => !scanNames(s).some((n) => curatedRepos.has(n)))
    .map((s) => ({
      id: s.canonicalName || s.folder,
      label: s.canonicalName || s.folder,
      kind: 'backend',
      repo: s.canonicalName || s.folder,
      repoName: s.repoName,
      canonicalName: s.canonicalName,
      host: null,
      derived: true,
      needsCuration: true,
    }))
  const BE_NODES = [...curatedBE, ...derivedBE]
  const BE_BY_ID = Object.fromEntries(BE_NODES.map((b) => [b.id, b]))
  // resolve a backend by any of its names (id / repo / GitHub repo name / label / inventory alias
  // or name), so integrations rows (keyed by inventory/repo name) and feBe wiring (by id) all land.
  const beIdByKey = {}
  for (const be of BE_NODES) {
    const inv = invForBackend(be)
    for (const k of [be.id, be.repo, be.repoName, be.canonicalName, be.label, be.invAlias, inv?.name].filter(Boolean))
      beIdByKey[String(k).toLowerCase()] = be.id
  }
  const beId = (name) => beIdByKey[String(name).toLowerCase()] || null

  // Connections per backend — surfaced in the Details panel ("Used by" / "Talks to"). FE consumers
  // come from the FE→BE wiring; service partners from integrations.csv (either direction).
  const beConsumers = {} // beId -> [{ id, label }]  (id lets the Details panel navigate to the card)
  // same scope rule as `repos` above — out-of-org repos aren't on the map, so a
  // "Used by" chip for one would be a dead click
  for (const r of data.repos || [])
    if (r.kind !== 'personal' && r.inOrg !== false && !hidden.has(r.folder))
      for (const id of feBe[r.folder] || []) (beConsumers[id] = beConsumers[id] || []).push({ id: nodeIdOf(r), label: r.displayName || r.folder })
  const bePartners = {} // beId -> [{ id, name, channel }]
  const addPartner = (host, partnerId, name, channel) => {
    const list = (bePartners[host] = bePartners[host] || [])
    if (name && !list.some((p) => p.id === partnerId)) list.push({ id: partnerId, name, channel: channel || null })
  }
  for (const it of data.integrations || []) {
    const s = beId(it.source),
      t = beId(it.target)
    if (s && t && s !== t) {
      addPartner(s, t, BE_BY_ID[t]?.label || it.target, it.channel)
      addPartner(t, s, BE_BY_ID[s]?.label || it.source, it.channel)
    }
  }

  // add a backend/service/storage node. Description + tooling come live from the scan
  // (backend-scan.mjs reads each cloned repo's build.gradle/pom.xml) and the linked inventory
  // entry's GitHub description; both fall back to the curated overlay values for repos that
  // aren't cloned (archived skycore-keycloak, the repo-less assets blob). host/wiring stay curated.
  // match a scanned entry to a backend node by any shared name (folder / remote basename /
  // canonical name / curated repo), so tooling + freshness attach even when the clone folder
  // differs from the curated `repo` (stale-named local clone vs canonical CI clone).
  const scanForBackend = (be) => {
    const keys = new Set([be.repo, be.repoName, be.canonicalName].filter(Boolean))
    return scannedBE.find((s) => scanNames(s).some((n) => keys.has(n)))
  }
  const addBackend = (id) => {
    const be = BE_BY_ID[id]
    if (!be) return
    const inv = invForBackend(be)
    const scan = scanForBackend(be)
    const tooling = (scan?.tooling?.length ? scan.tooling : be.tooling) || []
    add({
      id,
      type: 'card',
      position: { x: 0, y: 0 },
      data: {
        title: be.label,
        subtitle: inv?.description || be.desc,
        kind: be.kind,
        chips: tooling,
        resource: {
          ...be,
          tooling,
          modules: scan?.modules || [],
          lastCommit: scan?.lastCommit,
          consumers: beConsumers[id] || [],
          partners: bePartners[id] || [],
        },
        inventory: inv,
        status: inv?.status || null,
        flags: be.needsCuration ? { incomplete: true } : flagsFor(be.repo),
      },
    })
  }

  // staleness: a repo not committed to in > STALE_DAYS (relative to the data's generation date).
  // Configurable via config.json `staleDays`; defaults to 120.
  const asOf = data.generatedAt ? new Date(data.generatedAt).getTime() : Date.now()
  const STALE_DAYS = Number(data.config?.staleDays) > 0 ? Number(data.config.staleDays) : 120
  const staleDays = (r) => (r.lastCommit ? Math.round((asOf - new Date(r.lastCommit).getTime()) / 86400000) : null)
  const isStale = (r) => {
    const d = staleDays(r)
    return d != null && d > STALE_DAYS
  }

  // pipeline-health flags, surfaced as small badges on the cards (detail lives in the ⚠ popover):
  // newly-discovered repos (not yet curated) and half-curated repos (missing owner/status/desc).
  const v = data.validation || {}
  const newSet = new Set(v.newlyDiscovered || [])
  const incompleteSet = new Set([...(v.uncuratedRepos || []), ...(v.incompleteCuration || []).map((s) => String(s).split(' — ')[0])])
  const flagsFor = (folder) => {
    const f = {}
    if (newSet.has(folder)) f.isNew = true
    if (incompleteSet.has(folder)) f.incomplete = true
    return f
  }

  for (const r of repos) {
    add({
      id: nodeIdOf(r),
      type: 'card',
      position: { x: 0, y: 0 },
      data: {
        // prefer the curated inventory name so the card matches the Table/Matrix (e.g. the repo
        // folder `device-data-service` shows as its inventory name `device-data-ingestion`).
        title: r.inventory?.name || r.displayName || r.folder,
        subtitle: r.name || '',
        kind: r.kind,
        chips: mode === 'dev' ? chipsFor(r) : [],
        tags: tagObjs(r),
        repo: r,
        inventory: r.inventory || null,
        status: r.inventory?.status || null,
        stale: isStale(r),
        staleDays: staleDays(r),
        flags: flagsFor(r.folder),
      },
    })
  }

  // @framework/ui version drift: "latest" is the highest version of any consumer references (the ui
  // repo's own package.json version lags the published versions, so it's not a reliable baseline).
  const verParts = (v) =>
    String(v || '')
      .replace(/^[\^~>=<\s]+/, '')
      .split(/[.\-+]/)
      .map((x) => parseInt(x, 10) || 0)
  const cmpVer = (a, b) => {
    const A = verParts(a),
      B = verParts(b)
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0)
    }
    return 0
  }
  // Baseline over ALL in-scope repos, not the group-filtered survivors: hiding the cluster that
  // happens to contain the most current consumer must not lower "latest" and re-color the
  // remaining drift edges.
  const scdVersions = (data.repos || [])
    .filter((r) => r.kind !== 'personal' && r.inOrg !== false)
    .flatMap((r) => (isUiPkg(r.name) ? [] : (r.internalDeps || []).filter((d) => isUiPkg(d.name)).map((d) => d.version)))
  const scdLatest = scdVersions.sort(cmpVer).slice(-1)[0] || null

  // map an internal package name -> its curated repo card, so an internal-dep edge points at the
  // real card instead of spawning a duplicate "pkg:" node (rich-table, theme, etc. are now cards).
  const repoByPkg = {}
  for (const r of repos) if (r.name) repoByPkg[r.name] = nodeIdOf(r)
  // internal dependency edges (the design system + every other first-party package)
  for (const r of repos) {
    // one edge per package: a pkg listed as both prod + dev dep would collide on edge id, so
    // dedupe by name (prefer the prod entry / its version).
    const rid = nodeIdOf(r) // repo card node id (serviceId||folder) — dep-edge source + self-loop check
    const deps = []
    const byDepName = {}
    for (const d of r.internalDeps || []) {
      if (!byDepName[d.name]) {
        byDepName[d.name] = d
        deps.push(d)
      } else if (byDepName[d.name].dev && !d.dev) Object.assign(byDepName[d.name], d)
    }
    for (const d of deps) {
      let target
      const isScd = isUiPkg(d.name)
      if (isScd) target = nodeIdByFolder['ui'] ?? 'ui'
      else if (repoByPkg[d.name])
        target = repoByPkg[d.name] // curated card — no duplicate pkg node
      else {
        target = 'pkg:' + d.name
        // a package can be curated (by its short name, scope stripped) — pick up its cluster
        // override so a cross-cutting lib (cluster-shared) lands in Shared, not the pkg column.
        const short = d.name.replace(/^@[^/]+\//, '')
        const pinv = invByName[short.toLowerCase()] || null
        add({
          id: target,
          type: 'card',
          position: { x: 0, y: 0 },
          data: {
            title: short,
            subtitle: d.name.startsWith('@') ? d.name.slice(0, d.name.indexOf('/')) + ' pkg' : 'internal pkg',
            kind: 'package',
            inventory: pinv,
            sharedPkg: pinv?.cluster === 'Shared',
            cssPkg: pinv?.cluster === 'CSS', // CSS-shared pkg (e.g. kb-core) — placed in the CSS lane
          },
        })
      }
      const behind = isScd && scdLatest && cmpVer(d.version, scdLatest) < 0
      // skip self-loops: the design system yalc-links its own package during local dev
      if (target === rid) continue
      if (ids.has(target))
        edges.push({
          id: `dep-${rid}-${target}`,
          source: rid,
          target,
          label: behind ? `${d.version} ⚠` : d.version,
          animated: isScd,
          data: { drift: !!behind, scdLatest },
          style: { stroke: behind ? '#e53935' : '#7c4dff', strokeWidth: isScd ? 2 : 1, strokeDasharray: behind ? '6 3' : undefined },
          labelStyle: { fontSize: 10, fill: behind ? '#c62828' : '#5e35b1' },
          labelBgStyle: { fill: behind ? '#ffebee' : '#ede7f6' },
        })
    }
  }

  if (layers.backends) {
    const want = new Set()
    for (const r of repos) (feBe[r.folder] || []).forEach((id) => want.add(id))
    // backend↔backend edges now come from integrations.csv (both endpoints resolve to backend nodes),
    // replacing the old hardcoded BE_BE array.
    const beInternal = []
    for (const it of data.integrations || []) {
      const s = beId(it.source),
        t = beId(it.target)
      if (s && t && s !== t) {
        want.add(s)
        want.add(t)
        beInternal.push({ s, t, it })
      }
    }
    for (const be of BE_NODES) if (want.has(be.id)) addBackend(be.id)
    // FE -> backend/service/storage
    for (const r of repos)
      for (const t of feBe[r.folder] || [])
        if (ids.has(t))
          edges.push({
            id: `be-${nodeIdOf(r)}-${t}`,
            source: nodeIdOf(r),
            target: t,
            style: { stroke: '#fb8c00', strokeWidth: 1, opacity: 0.4 },
          })
    // backend -> backend / service, sourced from integrations.csv (deduped by node pair). Unverified
    // rows (seeded from a description, not confirmed) render finer + dimmer, matching service links.
    const seenBe = new Set()
    for (const { s, t, it } of beInternal) {
      const key = s + '>' + t
      if (seenBe.has(key) || !ids.has(s) || !ids.has(t)) continue
      seenBe.add(key)
      const unverified = it.verified === false
      edges.push({
        id: `bebe-${s}-${t}`,
        source: s,
        target: t,
        label: it.channel || undefined,
        data: it.channelFull ? { channelFull: it.channelFull } : undefined,
        style: { stroke: '#6d4c41', strokeDasharray: unverified ? '1 4' : '2 3', strokeWidth: 1, opacity: unverified ? 0.4 : 0.55 },
        labelStyle: { fontSize: 9, fill: '#4e342e' },
        labelBgStyle: { fill: '#efebe9' },
      })
    }
  }

  if (layers.deploy) {
    const deployTargets = deployTargetsOf(data.config)
    for (const inf of deployTargets)
      add({ id: inf.id, type: 'card', position: { x: 0, y: 0 }, data: { title: inf.label, subtitle: 'deploy target', kind: 'infra' } })
    // backends flagged deployArtifact are deployment artifacts, but they're still backend nodes:
    // the Resources layer is authoritative for whether they render, so don't resurrect one here
    // while Resources is off (that left pharma-backend visible inside a hidden Resources cluster).
    if (layers.backends) for (const be of BE_NODES) if (be.deployArtifact && !ids.has(be.id)) addBackend(be.id)
    const dpl = (id, target) =>
      edges.push({ id: `dpl-${target}-${id}`, source: id, target, style: { stroke: '#ef5350', strokeDasharray: '2 2', strokeWidth: 1, opacity: 0.4 } })
    // repo deploy edges from real workflow targets (descriptor `match` regexes); test harnesses
    // with no deploy target link to the CI node.
    const matchers = deployTargets.filter((t) => t.match).map((t) => [new RegExp(t.match, 'i'), t.id])
    const ciTarget = deployTargets.find((t) => t.testsFallback)?.id
    for (const r of repos) {
      const tgt = (r.deployment || [])
        .flatMap((d) => d.target || [])
        .join(' ')
        .toLowerCase()
      for (const [re, id] of matchers) if (re.test(tgt)) dpl(nodeIdOf(r), id)
      if (!tgt && r.kind === 'tests' && ciTarget) dpl(nodeIdOf(r), ciTarget)
    }
    // backend/service deploy targets — curated per backend (backend-extra.json `deployTarget`)
    for (const be of BE_NODES) if (be.deployTarget && ids.has(be.id)) dpl(be.id, be.deployTarget)
  }

  // External / SaaS integration cards (optional layer)
  if (layers.integrations) {
    const addExt = (name) => {
      const id = 'ext:' + name
      add({ id, type: 'card', position: { x: 0, y: 0 }, data: { title: name, subtitle: 'external service', kind: 'external' } })
      return id
    }
    const extEdge = (src, name) => {
      const id = addExt(name)
      edges.push({ id: `ext-${src}-${name}`, source: src, target: id, style: { stroke: '#5e35b1', strokeDasharray: '4 3', strokeWidth: 1, opacity: 0.5 } })
    }
    for (const r of repos) for (const e of r.externals || []) extEdge(nodeIdOf(r), e.name)
    // backend integrations (pharma-backend -> OpenAI, GoComet); ensure the backend node exists so the edge shows
    for (const [be, names] of Object.entries(backendExternals)) {
      if (!names.length) continue
      if (!ids.has(be)) addBackend(be)
      for (const name of names) extEdge(be, name)
    }
  }

  // Curated service edges (backend-extra.json `serviceEdges`) — node-to-node relationships that
  // can't be auto-derived (FE→FE embeds, design-token feeds, backend→FE-service calls). Drawn only
  // when both endpoints are on the map, so a backend-touching edge is naturally gated by the
  // Resources/Deployments layers. Backend-touching edges render brown-dashed (matching the
  // backend↔backend style); pure FE edges render teal.
  for (const { source: rawS, target: rawT, label } of serviceEdges) {
    const s = resolveRef(rawS),
      t = resolveRef(rawT) // curated by folder; alias to the card node id
    if (!s || !t || !ids.has(s) || !ids.has(t)) continue
    const touchesBackend = BE_BY_ID[s] || BE_BY_ID[t]
    edges.push({
      id: `svc-${s}-${t}`,
      source: s,
      target: t,
      label: label || undefined,
      style: touchesBackend ? { stroke: '#6d4c41', strokeDasharray: '2 3', strokeWidth: 1.2, opacity: 0.6 } : { stroke: '#0097a7', strokeWidth: 1.6 },
      labelStyle: touchesBackend ? { fontSize: 10, fill: '#4e342e' } : { fontSize: 10, fill: '#00838f' },
      labelBgStyle: { fill: touchesBackend ? '#efebe9' : '#e0f7fa' },
    })
  }

  // Consumer apps -> the shared asset bucket (backend-extra.json `assetConsumers` / `assetsSource`)
  for (const rawR of assetConsumers) {
    const r = resolveRef(rawR) // consumer curated by folder; alias to the card node id
    if (ids.has(r) && ids.has(assetsSource))
      edges.push({
        id: `asset-${r}`,
        source: r,
        target: assetsSource,
        style: { stroke: '#546e7a', strokeDasharray: '5 3', strokeWidth: 1.2, opacity: 0.6 },
      })
  }

  // Repo-less content sources (backend-extra.json `contentRepos`) — drawn next to their parent
  // card with a labeled edge (e.g. knowledge-base ← knowledge-base-articles, pushed from Stoplight).
  for (const c of contentRepos) {
    const parent = resolveRef(c.parent) // parent curated by folder; alias to the card node id
    if (!c.id || !c.parent || !ids.has(parent)) continue
    add({
      id: c.id,
      type: 'card',
      position: { x: 0, y: 0 },
      data: { title: c.label || c.id, subtitle: c.subtitle || 'content', kind: 'content', parentId: parent },
    })
    edges.push({
      id: `content-${parent}-${c.id}`,
      source: parent,
      target: c.id,
      label: c.edgeLabel || undefined,
      style: { stroke: '#8d6e63', strokeWidth: 1.4 },
      labelStyle: { fontSize: 10, fill: '#4e342e' },
      labelBgStyle: { fill: '#efebe9' },
    })
  }

  // Component catalog (optional): every inventory component not already drawn as a node, as a
  // grouped grid. Service -> 'component' (new kind), Client -> 'client', Third-Party -> 'external'.
  if (layers.components && (data.inventory || []).length) {
    const represented = new Set(nodes.filter((n) => n.data?.inventory).map((n) => n.data.inventory.name))
    for (const e of data.inventory) {
      if (represented.has(e.name)) continue
      const kind = e.type === 'Client' ? 'client' : /third/i.test(e.type) ? 'external' : 'component'
      add({
        id: 'inv:' + e.name,
        type: 'card',
        position: { x: 0, y: 0 },
        data: { title: e.name, subtitle: e.owner + (e.abbr ? ' · ' + e.abbr : ''), kind, inventory: e, status: e.status, chips: [] },
      })
    }
  }

  // Service-to-service integrations (REST / Kafka). Endpoints are inventory component names;
  // "Kafka" resolves to a shared event-bus node. Endpoint components that aren't on the map yet
  // are MATERIALIZED as inventory cards — switching this layer on must show the services a link
  // touches, not silently drop the edge because the full Components catalog happens to be off
  // ("services don't show despite being selected"). The bus node is only added when a row that
  // uses it actually draws, so it can never appear as an orphan.
  if (layers.serviceLinks && (data.integrations || []).length) {
    const idByInv = {}
    for (const n of nodes) if (n.data?.inventory) idByInv[n.data.inventory.name] = n.id
    let kafka = false
    const addBus = () => {
      if (!kafka) {
        add({ id: 'bus:kafka', type: 'card', position: { x: 0, y: 0 }, data: { title: 'Kafka', subtitle: 'event bus', kind: 'bus' } })
        kafka = true
      }
      return 'bus:kafka'
    }
    // Can this endpoint name resolve at all (bus / drawn node / known inventory component)?
    const resolvable = (name) => name === 'Kafka' || !!idByInv[name] || !!invByName[String(name).toLowerCase()]
    const resolve = (name) => {
      if (name === 'Kafka') return addBus()
      if (idByInv[name]) return idByInv[name]
      const e = invByName[String(name).toLowerCase()]
      if (!e) return null
      // materialize the missing component as a catalog-style card (same shape the Components layer draws)
      const kind = e.type === 'Client' ? 'client' : /third/i.test(e.type) ? 'external' : 'component'
      const id = 'inv:' + e.name
      add({
        id,
        type: 'card',
        position: { x: 0, y: 0 },
        data: { title: e.name, subtitle: e.owner + (e.abbr ? ' · ' + e.abbr : ''), kind, inventory: e, status: e.status, chips: [] },
      })
      idByInv[e.name] = id
      return id
    }
    for (const it of data.integrations) {
      // backend↔backend rows are drawn in the backends layer (as topology edges), not here.
      if (beId(it.source) && beId(it.target)) continue
      // resolve only when BOTH endpoints can land, so one resolvable side never materializes
      // a card (or the bus) for an edge that then can't draw.
      if (!resolvable(it.source) || !resolvable(it.target)) continue
      const s = resolve(it.source),
        t = resolve(it.target)
      if (!s || !t || !ids.has(s) || !ids.has(t)) continue
      const kafkaEdge = it.protocol === 'Kafka'
      // Unverified links (seeded from a description, not confirmed from code) render faint + finely
      // dotted with a ⚠ on the label, so they read as inferred rather than fact.
      const unverified = it.verified === false
      const text = kafkaEdge ? it.channel || 'Kafka' : it.channel || ''
      edges.push({
        // protocol in the id: a pair can talk BOTH REST and Kafka (two rows, same node pair), so
        // keying on s-t alone would collide (duplicate React keys / one edge dropped).
        id: `link-${kafkaEdge ? 'k' : 'r'}-${s}-${t}`,
        source: s,
        target: t,
        label: (unverified ? '⚠ ' : '') + text || undefined,
        data: it.channelFull ? { channelFull: it.channelFull } : undefined,
        style: unverified
          ? { stroke: kafkaEdge ? '#fb8c00' : '#00838f', strokeDasharray: '1 4', strokeWidth: 1.2, opacity: 0.45 }
          : kafkaEdge
            ? { stroke: '#fb8c00', strokeDasharray: '5 3', strokeWidth: 1.6 }
            : { stroke: '#00838f', strokeWidth: 1.6 },
        labelStyle: { fontSize: 9, fill: unverified ? '#9aa3b5' : kafkaEdge ? '#e65100' : '#00838f' },
        labelBgStyle: { fill: unverified ? '#f0f1f3' : kafkaEdge ? '#fff3e0' : '#e0f7fa' },
      })
    }
  }

  // Edge-type visibility: keep the pre-hide edge list (so a HIDDEN class stays re-checkable in the
  // Legend), then drop any the user has hidden — before the orphan-prune + layout so a node left
  // edge-less by a hidden arrow class is pruned and the lanes reflow (same contract as facets).
  // The offered classes themselves are computed at the END of the build (post-facets), so the
  // Filters/Legend never list an arrow class with zero arrows actually remaining on the map.
  const edgesPreHide = edges
  if (hiddenEdges.size) edges = edges.filter((e) => !hiddenEdges.has(edgeTypeOf(e.id, e)))

  // drop backend/service/storage/infra nodes left with no edges (e.g., after hiding a cluster).
  // Catalog nodes ('inv:') are intentionally edge-less, so never prune them.
  const BOTTOM_KINDS = ['backend', 'extsvc', 'storage', 'infra', 'external']
  const used = new Set()
  edges.forEach((e) => {
    used.add(e.source)
    used.add(e.target)
  })
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (!n.id.startsWith('inv:') && BOTTOM_KINDS.includes(n.data.kind) && !used.has(n.id)) nodes.splice(i, 1)
  }

  // floating edges + arrowheads
  for (const e of edges) {
    e.type = 'floating'
    const c = e.style?.stroke || '#888'
    e.markerEnd = { type: MarkerType.ArrowClosed, color: c, width: 16, height: 16 }
  }

  // Post-build facets — true filters: non-matching cards are removed (not dimmed), and both run
  // before layout so region boxes wrap only the survivors and empty clusters drop out.
  const dropNodes = (keep) => {
    const kept = nodes.filter(keep)
    const keptIds = new Set(kept.map((n) => n.id))
    nodes = kept
    edges = edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target))
  }
  // Health facet first: keep only cards whose repo has alerts/failing CI (+ the bus node).
  if (facets?.health?.size) dropNodes((n) => n.data.kind === 'bus' || isAtRisk(n.data.inventory?.health || n.data.repo?.inventory?.health))
  // Status options for the Filters menu = the statuses actually present on the (health- and
  // group-filtered, status-UNfiltered) map, so ticking one always narrows a visible set and a live
  // selection never blanks the whole canvas.
  const statusOptions = [...new Set(nodes.map((n) => n.data?.inventory?.status).filter(Boolean))].sort()
  // Status facet: nodes without inventory (e.g. the Kafka bus) carry no status, so an active
  // status filter removes them.
  if (facets?.status?.size && !coversAll(facets.status, statusOptions)) dropNodes((n) => matchStatus(n.data?.inventory, facets))

  // Component toggle-list — EVERY card drawn on the map is listable & hideable, keyed by its
  // lowercased display name (the inventory name when inventory-backed, else the card title with any
  // line breaks flattened). That makes diagram-context cards — content repos, internal packages,
  // deploy targets, the event bus, storage, external services — filterable too, so "shown on the
  // map" and "in the Components list" stay in lockstep. Options are captured BEFORE the drop so a
  // hidden card stays listed (re-checkable) in the Filters menu.
  const filterName = (n) => (n.data?.inventory?.name || n.data?.title || '').replace(/\s+/g, ' ').trim() || null
  const componentOptions = [...new Set(nodes.map(filterName).filter(Boolean))].sort()
  // Symmetry (see coversAll): unchecking every card must behave like checking every card — both
  // impose no constraint (show all). Without this, clearing the whole list would blank the canvas.
  if (
    facets?.hidden?.size &&
    !coversAll(
      facets.hidden,
      componentOptions.map((o) => o.toLowerCase()),
    )
  )
    dropNodes((n) => {
      const k = filterName(n)
      return !k || !facets.hidden.has(k.toLowerCase())
    })

  // `filtered` = the user intentionally removed nodes (group/health/status selection). It tells
  // clusterLayout to keep the lane layout even when a filter happens to drop the design-system hub —
  // vs. treating a missing hub as the stale-data symptom that warrants the dagre fallback.
  const filtered = facetsActive(facets)
  // Arrow classes offered as Legend/Filters toggles: classes whose edges survive the facet passes
  // (both endpoints still drawn), taken from the PRE-hide list so a hidden class stays listed.
  const finalIds = new Set(nodes.map((n) => n.id))
  const edgeTypesPresent = [...new Set(edgesPreHide.filter((e) => finalIds.has(e.source) && finalIds.has(e.target)).map((e) => edgeTypeOf(e.id, e)))].filter(
    (t) => t !== 'other',
  )
  return {
    ...clusterLayout(nodes, edges, layout, data.config, filtered, grouping),
    facetOptions: { status: statusOptions, components: componentOptions },
    edgeTypesPresent,
  }
}

// Card tile size — whole multiples of the 16px drag grid (14 × 6 cells), matching .node-card CSS.
const NODE_W = 224,
  NODE_H = 96

// Vertical order of app cards within their cluster lanes (config.json `layoutOrder`): folders are
// placed top-to-bottom in this order, and anything not listed appends below in data order. Hand-tune
// it when the automatic order puts the cards you compare most at opposite ends of a lane.
const DEFAULT_LAYOUT_ORDER = []

// Apply admin-curated position overrides (config.json `layout`) on top of the computed layout, so
// dragged cards keep their spot across rebuilds. Region boxes are computed afterwards, so a moved
// card stays inside its cluster outline.
function applyOverrides(nodes, layout) {
  if (!layout) return
  for (const n of nodes) {
    // alias: an old folder-keyed layout entry (config.json / a saved drag) still positions a node
    // whose id is now the serviceId. Without a serviceId n.id === folder, so this is byte-invariant.
    const o = layout[n.id] ?? layout[n.data?.repo?.folder]
    if (o && Number.isFinite(o.x) && Number.isFinite(o.y)) n.position = { x: o.x, y: o.y }
  }
}

// Structural region bands (the layer/topology boxes, not team clusters). These are
// derivation-fixed labels, so they carry their own colors here. Team-cluster colors are NOT
// hardcoded — they come from each cluster descriptor's `color` (DEFAULT_CLUSTERS / config.clusters),
// merged in below. STRUCTURAL_REGIONS is the subset a curator can annotate (see the Admin panel);
// 'Unclassified' is an internal catch-all and is intentionally excluded from it.
export const STRUCTURAL_REGIONS = ['Resources', 'Deployments', 'Integrations', 'Inventory catalog']
const STRUCTURAL_REGION_COLOR = {
  Resources: '#ef6c00',
  Deployments: '#c62828',
  Integrations: '#5e35b1',
  'Inventory catalog': '#00897b',
  Unclassified: '#9e9e9e',
}

// Logical team clusters: ISS (left) | Shared+ui (center) | CSS (right); backends in a row along the bottom.
// `grouping` (optional, from groupingFor) swaps the lane taxonomy for a derived one (application /
// platform) — same layout machinery, different membership function.
function clusterLayout(nodes, edges, layout, config = {}, filtered = false, grouping = null) {
  const clusters = grouping?.clusters || resolveClusters(config)
  // lane membership: the grouping's own function, else the team cluster of the repo's inventory
  const laneOf = (repo) => (grouping ? grouping.memberOf(repo?.inventory) : clusterOf(repo, clusters))
  const fallbackLabel = fallbackLabelOf(clusters)
  // Cluster outline colors: structural bands (STRUCTURAL_REGION_COLOR) + per-cluster descriptor
  // colors, overridable per-label via config.json `clusterColors`.
  const clusterColor = {
    ...STRUCTURAL_REGION_COLOR,
    ...Object.fromEntries(clusters.filter((c) => c.color).map((c) => [c.label, c.color])),
    ...config?.clusterColors,
  }
  // The lane layout is driven entirely by the cluster descriptors + node data, so it doesn't need
  // the design-system card itself. Its absence only matters as a stale-data symptom: a lagging data
  // source that dropped the hub likely dropped much else, so we flatten to dagre and warn. But when
  // a filter is active the hub may have been *intentionally* removed — keep the lanes in that case.
  // An estate with no design system configured has no hub at all; that's not a symptom of anything.
  const hubFolders = uiHubFoldersOf(config)
  const hasHub = uiPackagesOf(config).size > 0
  const hub = nodes.find((n) => hubFolders.includes(n.id) || hubFolders.includes(n.data?.repo?.folder))
  if (hasHub && !hub && !filtered) {
    console.warn(`clusterLayout: design-system hub node not found (looked for ${hubFolders.join('/')}) — falling back to dagre layout`)
    return dagreLayout(nodes, edges, layout)
  }
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))
  const allPkgs = nodes.filter((n) => n.data.kind === 'package')
  // A package's cluster comes from its inventory `cluster` (e.g. kb-core → CSS). Packages routed to a
  // lane ride that lane; fallback-cluster packages sit in the centre; the rest form the loose column.
  const pkgClusterOf = (p) => p.data.inventory?.cluster || null
  const centerPkgs = allPkgs.filter((p) => pkgClusterOf(p) === fallbackLabel)
  const loosePkgs = allPkgs.filter((p) => !pkgClusterOf(p)) // no cluster → loose column left of the leftmost lane
  const backends = nodes.filter((n) => ['backend', 'extsvc', 'storage'].includes(n.data.kind))
  const infra = nodes.filter((n) => n.data.kind === 'infra')

  const stack = (arr, x, cy = 0, gap = 112) => {
    const total = (arr.length - 1) * gap
    arr.forEach((n, i) => {
      n.position = { x: x - NODE_W / 2, y: cy + i * gap - total / 2 - NODE_H / 2 }
    })
  }
  // vertical stack that wraps into balanced columns once it would get too tall; extra columns
  // grow in `dir` (+1 right / -1 left) from x0. Returns the column count so neighbours can clear it.
  const COL_GAP = NODE_W + 64
  const stackCols = (arr, x0, { dir = 1, perCol = 8, gap = 112, cy = 0 } = {}) => {
    if (!arr.length) return 0
    const cols = Math.ceil(arr.length / perCol)
    const per = Math.ceil(arr.length / cols) // balance: e.g. 16 -> 2 cols of 8, not 8+8 vs 8+0
    arr.forEach((n, i) => {
      const col = Math.floor(i / per),
        row = i % per
      const colCount = Math.min(per, arr.length - col * per)
      const total = (colCount - 1) * gap
      n.position = { x: x0 + dir * col * COL_GAP - NODE_W / 2, y: cy + row * gap - total / 2 - NODE_H / 2 }
    })
    return cols
  }
  // mean-x of a node's consumers (the cards that point at it)
  const consumerMeanX = (n) => {
    const cons = edges
      .filter((e) => e.target === n.id)
      .map((e) => byId[e.source])
      .filter(Boolean)
    return cons.length ? cons.reduce((s, c) => s + c.position.x, 0) / cons.length : 0
  }
  // place each node under the mean-x of its consumers, then de-overlap left->right (single row)
  const placeUnder = (arr, y) => {
    const withX = arr.map((n) => ({ n, mx: consumerMeanX(n) })).sort((a, b) => a.mx - b.mx)
    const GAP = NODE_W + 40
    let prev = -Infinity
    withX.forEach(({ n, mx }) => {
      const x = Math.max(mx, prev + GAP)
      prev = x
      n.position = { x, y: y - NODE_H / 2 }
    })
  }
  // lay nodes in a compact grid centred on x=cx0, growing UP from bottomY (keeps wide
  // fan-outs like the integration layer from sprawling into a single 4000px-wide row).
  const placeGrid = (arr, { bottomY, cols, cx0 = 0, gapX = NODE_W + 36, gapY = 96 }) => {
    const ordered = arr
      .map((n) => ({ n, mx: consumerMeanX(n) }))
      .sort((a, b) => a.mx - b.mx)
      .map((o) => o.n)
    const rows = Math.ceil(ordered.length / cols)
    ordered.forEach((n, i) => {
      const row = Math.floor(i / cols)
      const inRow = Math.min(cols, ordered.length - row * cols)
      const rowW = (inRow - 1) * gapX
      const col = i % cols
      n.position = { x: cx0 - rowW / 2 + col * gapX - NODE_W / 2, y: bottomY - (rows - 1 - row) * gapY - NODE_H / 2 }
    })
  }

  // Lane app columns: membership derived from the owning team (clusterOf), ordered by a curated
  // hint so a hand-tuned vertical order is preserved and unknown repos append below (config.json
  // `layoutOrder`; unset, everything sorts equal and falls back to data order).
  const layoutOrder = Array.isArray(config?.layoutOrder) && config.layoutOrder.length ? config.layoutOrder : DEFAULT_LAYOUT_ORDER
  const orderHint = (n) => {
    // layoutOrder is keyed by repo FOLDER (DEFAULT_LAYOUT_ORDER / config.layoutOrder), so resolve a
    // node's order by its repo folder — the node id is now the serviceId, which needn't match.
    const i = layoutOrder.indexOf(n.data.repo?.folder ?? n.id)
    return i < 0 ? 999 : i
  }
  const clusterApps = (label) => nodes.filter((n) => n.data.repo && laneOf(n.data.repo) === label).sort((a, b) => orderHint(a) - orderHint(b))

  // Team-cluster lanes, driven by the cluster descriptors. Each non-fallback cluster is a vertical
  // lane of its apps (+ packages routed to it). Anchors: a number is an absolute x; 'after:<label>'
  // sits just past that lane; no anchor → auto-distribute left→right by list order, which is the
  // sane default until you want a specific arrangement.
  const laneClusters = clusters.filter((c) => !c.fallback)
  const anchorByLabel = {}
  const colsByLabel = {}
  const memberByLabel = {}
  let autoX = 760
  for (const c of laneClusters) {
    if (typeof c.anchor === 'number') anchorByLabel[c.label] = c.anchor
    else if (typeof c.anchor === 'string' && c.anchor.startsWith('after:')) {
      const ref = c.anchor.slice(6)
      anchorByLabel[c.label] = (anchorByLabel[ref] ?? 0) + (colsByLabel[ref] ?? 1) * COL_GAP + 120
    } else {
      anchorByLabel[c.label] = autoX
      autoX += COL_GAP * 2 + 120
    }
    const apps = clusterApps(c.label)
    const lanePkgs = allPkgs.filter((p) => pkgClusterOf(p) === c.label)
    // content-repo nodes (backend-extra.json `contentRepos`) follow their parent card's lane
    const laneContent = nodes.filter((n) => n.data.kind === 'content' && n.data.parentId && laneOf(byId[n.data.parentId]?.data?.repo || {}) === c.label)
    const members = [...apps, ...laneContent, ...lanePkgs]
    memberByLabel[c.label] = members
    colsByLabel[c.label] = stackCols(members, anchorByLabel[c.label], { dir: c.dir ?? 1 })
  }
  // loose packages (no cluster) sit just left of the leftmost lane, in their own column
  const leftmostLabel = laneClusters.length ? laneClusters.reduce((a, c) => (anchorByLabel[c.label] < anchorByLabel[a.label] ? c : a)).label : null
  const leftmostX = leftmostLabel ? anchorByLabel[leftmostLabel] - (colsByLabel[leftmostLabel] || 0) * COL_GAP - 40 : -690
  stack(loosePkgs, leftmostX)

  // Fallback cluster (centre): genuinely suite-wide repos (inventory cluster = fallback) + fallback
  // packages, in a centre column. When nothing is suite-wide it's empty and no box renders.
  const sharedExtras = [...nodes.filter((n) => n.data.repo?.inventory?.cluster === fallbackLabel), ...centerPkgs]
  sharedExtras.forEach((n, i) => {
    n.position = { x: -40 - NODE_W / 2, y: -160 + i * 104 - NODE_H / 2 }
  })
  const sharedNodes = sharedExtras

  // external integration cards in a compact grid along the TOP, centred over the apps.
  // bottomY sits clear above the main row's tallest box (Shared) so the boxes never overlap.
  const externals = nodes.filter((n) => n.data.kind === 'external')
  if (externals.length) placeGrid(externals, { bottomY: -430, cols: 5, cx0: 0 })

  // any repo not assigned to a known cluster (e.g., a newly added repo after a regen)
  const laneNodes = laneClusters.flatMap((c) => memberByLabel[c.label] || [])
  const known = new Set([...laneNodes, ...loosePkgs, ...sharedNodes, ...externals].map((n) => n.id))
  const unclassified = nodes.filter(
    (n) =>
      !known.has(n.id) &&
      !n.id.startsWith('inv:') &&
      !n.id.startsWith('bus:') &&
      !['backend', 'extsvc', 'storage', 'infra', 'component', 'bus'].includes(n.data.kind),
  )
  if (unclassified.length) stack(unclassified, -1520)
  // Backends row along the bottom (ordered under their consumers); infra below it.
  // y-offsets give each band a clear gap from the main row above so boxes never overlap.
  if (backends.length) placeUnder(backends, 470)
  if (infra.length) placeUnder(infra, 690)

  // Component catalog: edge-less inventory components, grouped by owner team, in a grid below
  // everything else (its own band, so it never overlaps the relationship graph above).
  const kafka = byId['bus:kafka']
  if (kafka) kafka.position = { x: -NODE_W / 2, y: 850 - NODE_H / 2 } //  center, just above the catalog band
  const components = nodes.filter((n) => n.id.startsWith('inv:'))
  if (components.length) {
    const ordered = [...components].sort((a, b) => (a.data.inventory?.owner || '').localeCompare(b.data.inventory?.owner || '') || a.id.localeCompare(b.id))
    const cols = 7,
      gapX = NODE_W + 30,
      gapY = 104,
      top = 980
    ordered.forEach((n, i) => {
      const row = Math.floor(i / cols),
        col = i % cols
      const inRow = Math.min(cols, ordered.length - row * cols)
      n.position = { x: -((inRow - 1) * gapX) / 2 + col * gapX - NODE_W / 2, y: top + row * gapY - NODE_H / 2 }
    })
  }

  // admin drag overrides land before the cluster boxes are measured, so boxes wrap moved cards
  applyOverrides(nodes, layout)

  const regions = []
  // outlier-tolerant bounds: a card dragged far out of its cluster shouldn't balloon the outline
  // across the canvas. Use Tukey fences (per axis) for sizeable clusters; a generous fixed cap for
  // small ones. Members outside the fence still render — they just sit outside the cluster box.
  const fence = (vals) => {
    const s = [...vals].sort((a, b) => a - b)
    const n = s.length
    const mid = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
    if (n < 5) return [mid - 2200, mid + 2200]
    const q = (p) => s[Math.floor((n - 1) * p)]
    const iqr = Math.max(q(0.75) - q(0.25), 250)
    return [q(0.25) - iqr * 2.5, q(0.75) + iqr * 2.5]
  }
  const box = (label, members) => {
    const ms = members.filter(Boolean)
    if (!ms.length) return
    const [xlo, xhi] = fence(ms.map((m) => m.position.x))
    const [ylo, yhi] = fence(ms.map((m) => m.position.y))
    let core = ms.filter((m) => m.position.x >= xlo && m.position.x <= xhi && m.position.y >= ylo && m.position.y <= yhi)
    if (!core.length) core = ms
    const xs = core.map((m) => m.position.x)
    const ys = core.map((m) => m.position.y)
    const minX = Math.min(...xs) - 34,
      maxX = Math.max(...xs) + NODE_W + 34
    const minY = Math.min(...ys) - 52,
      maxY = Math.max(...ys) + NODE_H + 30
    // admin geometry override (move/resize) wins over the computed bounds
    const ov = layout && layout['region-' + label]
    const hasOv = ov && Number.isFinite(ov.x) && Number.isFinite(ov.w)
    const px = hasOv ? ov.x : minX,
      py = hasOv ? ov.y : minY,
      w = hasOv ? ov.w : maxX - minX,
      h = hasOv ? ov.h : maxY - minY
    regions.push({
      id: 'region-' + label,
      type: 'region',
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -10,
      position: { x: px, y: py },
      style: { width: w, height: h },
      data: { label, color: clusterColor[label] || '#888', w, h, members: ms.map((m) => m.id) },
    })
  }
  // one outline per team-cluster lane (the leftmost lane's box also wraps the loose pkg column),
  // plus the fallback/centre cluster
  for (const c of laneClusters) box(c.label, [...(c.label === leftmostLabel ? loosePkgs : []), ...(memberByLabel[c.label] || [])])
  box(fallbackLabel, sharedNodes)
  if (externals.length) box('Integrations', externals)
  if (unclassified.length) box('Unclassified', unclassified)
  if (backends.length) box('Resources', backends)
  if (infra.length) box('Deployments', infra)
  if (components.length) box('Inventory catalog', components)

  return { nodes: [...regions, ...nodes], edges }
}

function dagreLayout(nodes, edges, layout) {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 120, marginx: 20, marginy: 20 })
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }))
  edges.forEach((e) => g.setEdge(e.source, e.target))
  dagre.layout(g)
  nodes.forEach((n) => {
    const p = g.node(n.id)
    n.position = { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 }
  })
  applyOverrides(nodes, layout)
  return { nodes, edges }
}
