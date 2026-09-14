// Structural tests for buildGraph against the real committed model. These guard the invariants
// the renderer relies on (no dangling edges, clusters + core nodes present, deterministic across
// option combos) — especially valuable before the reactflow→xyflow migration and the App split.
import { describe, it, expect } from 'vitest'
import { buildGraph, KIND, LAYERS, DEFAULT_LAYERS, resolveClusters, DEFAULT_CLUSTERS, matchInventory, isAtRisk, nodeIdOf, groupingFor } from './graph.js'
import main from '../../fe-architecture.json'
import extras from '../../fe-architecture-extras.json'
import config from '../../config.json'

// config is merged into the served data at serve time (server.mjs / bundle.mjs), so the test data
// carries it too — otherwise the graph would lay out against DEFAULT_CLUSTERS, not the real one.
const data = { ...main, config, extras }

// Everything below is DERIVED from the committed config + data rather than naming one estate's
// repos and teams, so the suite holds for whatever a fork configures.
const CLUSTERS = resolveClusters(config)
const ALL_CLUSTERS = CLUSTERS.map((c) => c.label)
const LANES = CLUSTERS.filter((c) => !c.fallback).map((c) => c.label)
const FALLBACK = CLUSTERS.find((c) => c.fallback)?.label ?? 'Shared'
const [LANE_A, LANE_B] = [LANES[0], LANES[1] ?? LANES[0]]
// an owner topic value that routes into LANE_A, for synthetic fixtures
const OWNER_A = (CLUSTERS.find((c) => c.label === LANE_A)?.match || [])[0] || LANE_A
const CORE_CLIENTS = main.repos
  .filter((r) => r.kind === 'client')
  .map((r) => r.folder)
  .slice(0, 3)
const INTERNAL_SCOPE = (config.internalScopes || ['@internal'])[0]
const groups = (...labels) => ({ group: new Set(labels) })
const ALL_LAYERS_ON = Object.fromEntries(LAYERS.map((l) => [l.key, true]))
const optionMatrix = [
  { label: 'overview defaults', opts: { mode: 'overview', facets: groups(LANE_A, FALLBACK) } },
  { label: 'dev all layers', opts: { mode: 'dev', layers: ALL_LAYERS_ON, facets: groups(...ALL_CLUSTERS) } },
  { label: 'one lane only', opts: { mode: 'dev', facets: groups(LANE_B) } },
  { label: 'no cluster filter (all shown)', opts: { mode: 'dev' } },
  { label: 'status facet', opts: { mode: 'dev', facets: { ...groups(...ALL_CLUSTERS), status: new Set(['Current']) } } },
  { label: 'health facet', opts: { mode: 'dev', facets: { health: new Set(['at-risk']) } } },
]

describe('groupingFor (Group by: Application / Platform)', () => {
  it('returns null for team (the default clusters stay in charge)', () => {
    expect(groupingFor(data, 'team')).toBeNull()
    expect(groupingFor(data, undefined)).toBeNull()
  })

  it('application grouping derives one lane per first-application, plus Other', () => {
    const g = groupingFor(data, 'application')
    expect(g).toBeTruthy()
    const labels = g.clusters.map((c) => c.label)
    expect(labels).toContain('Other')
    expect(labels.length).toBeGreaterThan(3)
    // membership: a component's first application names its lane; app-less → Other
    const withApp = data.inventory.find((e) => e.applications?.length)
    expect(g.memberOf(withApp)).toBe(withApp.applications[0])
    expect(g.memberOf({ applications: [] })).toBe('Other')
  })

  it('platform grouping follows config.platforms order and rolls apps up', () => {
    const config = { platforms: { P1: ['App A'], P2: ['App B'] } }
    const g = groupingFor({ ...data, config }, 'platform')
    expect(g.clusters.map((c) => c.label).slice(0, 2)).toEqual(['P1', 'P2'])
    expect(g.memberOf({ applications: ['App B'] })).toBe('P2')
    expect(g.memberOf({ applications: ['Unmapped App'] })).toBe('Other')
  })

  it('buildGraph lays out lanes without dangling edges under both groupings', () => {
    for (const by of ['application', 'platform']) {
      const g = buildGraph(data, { mode: 'dev', groupBy: by })
      const ids = new Set(g.nodes.map((n) => n.id))
      for (const e of g.edges) {
        expect(ids.has(e.source)).toBe(true)
        expect(ids.has(e.target)).toBe(true)
      }
      expect(g.nodes.some((n) => n.type === 'region')).toBe(true)
    }
  })
})

describe('buildGraph', () => {
  it('produces nodes and edges with valid kinds', () => {
    const g = buildGraph(data, { mode: 'dev', facets: groups(...ALL_CLUSTERS) })
    expect(g.nodes.length).toBeGreaterThan(10)
    for (const n of g.nodes) {
      if (n.type === 'card') expect(KIND[n.data.kind] || n.data.kind === 'bus').toBeTruthy()
    }
  })

  it('has region clusters and the core FE clients as cards', () => {
    const g = buildGraph(data, { mode: 'dev', facets: groups(...ALL_CLUSTERS) })
    expect(g.nodes.some((n) => n.type === 'region')).toBe(true)
    const cardIds = new Set(g.nodes.filter((n) => n.type === 'card').map((n) => n.id))
    for (const c of CORE_CLIENTS) expect(cardIds.has(c)).toBe(true)
  })

  it('never produces a dangling edge, under any option combo', () => {
    for (const { label, opts } of optionMatrix) {
      const g = buildGraph(data, opts)
      const ids = new Set(g.nodes.map((n) => n.id))
      for (const e of g.edges) {
        expect(ids.has(e.source), `${label}: edge source ${e.source}`).toBe(true)
        expect(ids.has(e.target), `${label}: edge target ${e.target}`).toBe(true)
      }
    }
  })

  it('does not throw and is stable across option combos', () => {
    for (const { opts } of optionMatrix) {
      const a = buildGraph(data, opts)
      const b = buildGraph(data, opts)
      expect(a.nodes.length).toBe(b.nodes.length)
      expect(a.edges.length).toBe(b.edges.length)
    }
  })

  it('defaults to the registry layer defaults (Resources + Deployments on)', () => {
    expect(DEFAULT_LAYERS.backends).toBe(true)
    expect(DEFAULT_LAYERS.deploy).toBe(true)
    expect(DEFAULT_LAYERS.integrations).toBe(false)
    const g = buildGraph(data, { mode: 'dev' })
    // deploy-target nodes present (deploy layer on by default), no external/SaaS cards (off)
    expect(g.nodes.some((n) => n.data?.kind === 'infra')).toBe(true)
    expect(g.nodes.some((n) => n.data?.kind === 'external')).toBe(false)
  })

  it('reports status facetOptions from the pre-status universe, then filters by status', () => {
    const base = buildGraph(data, { mode: 'dev', facets: groups(...ALL_CLUSTERS) })
    expect(base.facetOptions.status.length).toBeGreaterThan(0)
    const status = base.facetOptions.status[0]
    const filtered = buildGraph(data, { mode: 'dev', facets: { ...groups(...ALL_CLUSTERS), status: new Set([status]) } })
    // options stay scoped to the status-UNfiltered universe (so the menu doesn't shrink to the pick)
    expect(filtered.facetOptions.status).toEqual(base.facetOptions.status)
    for (const n of filtered.nodes.filter((n) => n.type === 'card' && n.data.inventory)) {
      expect(n.data.inventory.status).toBe(status)
    }
    expect(filtered.nodes.length).toBeLessThanOrEqual(base.nodes.length)
  })

  it('health facet keeps only at-risk cards (plus the bus node)', () => {
    const g = buildGraph(data, { mode: 'dev', facets: { health: new Set(['at-risk']) } })
    for (const n of g.nodes.filter((n) => n.type === 'card' && n.data.kind !== 'bus')) {
      expect(isAtRisk(n.data.inventory?.health || n.data.repo?.inventory?.health), n.id).toBe(true)
    }
  })

  it('matchInventory applies group, status and health with the same rules as the graph', () => {
    const inv = { name: 'x', owner: OWNER_A, status: 'Current', health: { alerts: { high: 1 } } }
    expect(matchInventory(inv, { group: new Set([LANE_A]) }, CLUSTERS)).toBe(true)
    if (LANE_B !== LANE_A) expect(matchInventory(inv, { group: new Set([LANE_B]) }, CLUSTERS)).toBe(false)
    expect(matchInventory(inv, { status: new Set(['Current']) })).toBe(true)
    expect(matchInventory(inv, { status: new Set(['Removed']) })).toBe(false)
    expect(matchInventory(inv, { health: new Set(['at-risk']) })).toBe(true)
    expect(matchInventory({ ...inv, health: undefined }, { health: new Set(['at-risk']) })).toBe(false)
    // hidden = per-component list keyed by lowercased name
    expect(matchInventory(inv, { hidden: new Set(['x']) })).toBe(false)
    expect(matchInventory(inv, { hidden: new Set(['other']) })).toBe(true)
  })

  it('draws curated serviceEdges when both endpoints are on the map', () => {
    const g = buildGraph(data, { mode: 'dev', facets: groups(...ALL_CLUSTERS) })
    const ids = new Set(g.nodes.map((n) => n.id))
    for (const e of data.backendTopology?.serviceEdges || []) {
      if (ids.has(e.source) && ids.has(e.target)) {
        expect(
          g.edges.some((x) => x.id === `svc-${e.source}-${e.target}`),
          `${e.source}→${e.target}`,
        ).toBe(true)
      }
    }
  })

  it('draws contentRepos next to their parent (kb-articles follows knowledge-base)', () => {
    const g = buildGraph(data, { mode: 'dev', facets: groups(...ALL_CLUSTERS) })
    const ids = new Set(g.nodes.map((n) => n.id))
    if (ids.has('knowledge-base')) {
      expect(ids.has('kb-articles')).toBe(true)
      expect(g.edges.some((e) => e.id === 'content-knowledge-base-kb-articles')).toBe(true)
    }
  })

  it('links backends to their curated deployTarget on the Deployments layer', () => {
    const g = buildGraph(data, { mode: 'dev', facets: groups(...ALL_CLUSTERS), layers: { backends: true, deploy: true } })
    const ids = new Set(g.nodes.map((n) => n.id))
    const withTarget = (data.backendTopology?.backends || []).filter((b) => b.deployTarget)
    expect(withTarget.length).toBeGreaterThan(0)
    for (const be of withTarget) {
      if (ids.has(be.id))
        expect(
          g.edges.some((e) => e.id === `dpl-${be.deployTarget}-${be.id}`),
          be.id,
        ).toBe(true)
    }
  })

  it('hides every backend node (incl. deployArtifact ones) when the Resources layer is off', () => {
    // Regression: pharma-backend is flagged deployArtifact and used to survive on the Deployments
    // layer even with Resources unchecked, leaving one lone card inside a hidden Resources cluster.
    const g = buildGraph(data, { mode: 'dev', facets: groups(...ALL_CLUSTERS), layers: { backends: false, deploy: true } })
    const backendKinds = new Set(['backend', 'extsvc', 'storage'])
    expect(g.nodes.some((n) => backendKinds.has(n.data.kind))).toBe(false)
    expect(g.nodes.some((n) => n.id === 'region-Resources')).toBe(false)
  })

  // Synthetic fixtures: a lane app depending on a first-party package, with and without a
  // `cluster-*` override. The override should pull the package into the centre (fallback) column;
  // without one it belongs to its consumer's lane and sits in that lane's far-left package column.
  const sharedPkg = `${INTERNAL_SCOPE}/kb-react`
  const lonePkg = `${INTERNAL_SCOPE}/some-lib`
  const laneApp = (deps) => ({
    folder: 'lane-app',
    kind: 'client',
    inventory: { name: 'lane-app', owner: OWNER_A },
    internalDeps: deps,
  })
  // The design-system hub must be present or clusterLayout treats the data as truncated and
  // flattens to dagre, where x positions carry no lane meaning — see uiHubFoldersOf in graph.js.
  const HUB = { folder: (config.uiHubFolders || ['ui'])[0], kind: 'library', inventory: { name: 'ui', owner: OWNER_A } }
  const withHub = (repos) => [HUB, ...repos]

  it(`routes a cluster-${'$'}{FALLBACK} package out of its lane column into the centre`, () => {
    const d = {
      config,
      repos: withHub([laneApp([{ name: sharedPkg, version: '1.0.0' }])]),
      inventory: [{ name: 'kb-react', cluster: FALLBACK, type: 'Library' }],
    }
    const g = buildGraph(d, { mode: 'dev' })
    const pkg = g.nodes.find((n) => n.id === `pkg:${sharedPkg}`)
    expect(pkg).toBeTruthy()
    expect(pkg.data.sharedPkg).toBe(true)
    // the centre columns sit near the origin; a lane's package column is far further left
    expect(pkg.position.x).toBeGreaterThan(-600)
  })

  it('a package with no cluster override stays in the (far-left) package column', () => {
    const withOverride = buildGraph(
      { config, repos: withHub([laneApp([{ name: sharedPkg, version: '1.0.0' }])]), inventory: [{ name: 'kb-react', cluster: FALLBACK, type: 'Library' }] },
      { mode: 'dev' },
    ).nodes.find((n) => n.id === `pkg:${sharedPkg}`)
    const noOverride = buildGraph({ config, repos: withHub([laneApp([{ name: lonePkg, version: '1.0.0' }])]), inventory: [] }, { mode: 'dev' }).nodes.find(
      (n) => n.id === `pkg:${lonePkg}`,
    )

    expect(noOverride.data.sharedPkg).toBeFalsy()
    // the un-overridden package sits in the lanes' own package column, left of the centre one —
    // an absolute x would just encode whatever anchors this config happens to use
    expect(noOverride.position.x).toBeLessThan(withOverride.position.x)
  })

  it('routes a cluster-overridden repo into the centre, not Unclassified', () => {
    const d = {
      config,
      repos: withHub([
        { folder: 'kb-react', kind: 'service', name: sharedPkg, inventory: { name: 'kb-react', cluster: FALLBACK } },
        laneApp([{ name: sharedPkg, version: '1.0.0' }]),
      ]),
      inventory: [{ name: 'kb-react', cluster: FALLBACK }],
    }
    const g = buildGraph(d, { mode: 'dev' })
    const ids = new Set(g.nodes.map((n) => n.id))
    expect(ids.has('kb-react')).toBe(true) // resolves to the repo card…
    expect(ids.has(`pkg:${sharedPkg}`)).toBe(false) // …not a duplicate pkg node
    expect(g.nodes.find((n) => n.id === 'kb-react').position.x).toBeGreaterThan(-600)
    expect(g.nodes.some((n) => n.id === 'region-Unclassified')).toBe(false)
  })

  it("materializes missing service-link endpoints so the layer never draws nothing (services-don't-show fix)", () => {
    const g = buildGraph(data, { mode: 'dev', layers: { serviceLinks: true } })
    const ids = new Set(g.nodes.map((n) => n.id))
    const links = g.edges.filter((e) => e.id.startsWith('link-'))
    // the committed data has integrations whose endpoints are inventory-only components —
    // they must appear as materialized cards with their edges, not vanish
    expect(links.length).toBeGreaterThan(0)
    for (const e of links) {
      expect(ids.has(e.source), e.id).toBe(true)
      expect(ids.has(e.target), e.id).toBe(true)
    }
    // the Kafka bus only exists when something actually connects to it (no orphan bus card)
    if (ids.has('bus:kafka')) {
      expect(g.edges.some((e) => e.source === 'bus:kafka' || e.target === 'bus:kafka')).toBe(true)
    }
  })

  it('hides edges of a type via hiddenEdges while still advertising it in edgeTypesPresent', () => {
    const base = buildGraph(data, { mode: 'dev', facets: groups(...ALL_CLUSTERS) })
    expect(base.edgeTypesPresent).toContain('dependency')
    expect(base.edges.some((e) => e.id.startsWith('dep-'))).toBe(true)
    const hidden = buildGraph(data, { mode: 'dev', facets: groups(...ALL_CLUSTERS), hiddenEdges: new Set(['dependency']) })
    // still offered as a toggle (so it can be switched back on) but no dependency arrow is drawn.
    // NB: red version-lag edges share the dep- id prefix but are the separate 'drift' type, so they
    // survive hiding 'dependency' — assert only non-drift dependency arrows are gone.
    expect(hidden.edgeTypesPresent).toContain('dependency')
    expect(hidden.edges.some((e) => e.id.startsWith('dep-') && !e.data?.drift)).toBe(false)
    // an unrelated type is untouched by the filter
    expect(hidden.edges.some((e) => e.id.startsWith('be-'))).toBe(base.edges.some((e) => e.id.startsWith('be-')))
  })

  it('hides a component by name via the hidden facet and keeps it listed in facetOptions.components', () => {
    const base = buildGraph(data, { mode: 'dev', facets: groups(...ALL_CLUSTERS) })
    expect(base.facetOptions.components.length).toBeGreaterThan(0)
    const name = base.facetOptions.components[0]
    const g = buildGraph(data, { mode: 'dev', facets: { ...groups(...ALL_CLUSTERS), hidden: new Set([name.toLowerCase()]) } })
    // the hidden component's card is dropped…
    expect(g.nodes.some((n) => n.data?.inventory?.name === name)).toBe(false)
    // …but it stays offered so it can be re-checked, and no dangling edge is left behind
    expect(g.facetOptions.components).toContain(name)
    const ids = new Set(g.nodes.map((n) => n.id))
    for (const e of g.edges) expect(ids.has(e.source) && ids.has(e.target)).toBe(true)
  })

  it('service links stay off the map when the layer is off', () => {
    const g = buildGraph(data, { mode: 'dev', layers: { serviceLinks: false } })
    expect(g.edges.some((e) => e.id.startsWith('link-'))).toBe(false)
    expect(g.nodes.some((n) => n.id === 'bus:kafka')).toBe(false)
  })

  it('styles unverified service links distinctly (dotted, dimmed)', () => {
    const g = buildGraph(data, { mode: 'dev', layers: { serviceLinks: true } })
    const links = g.edges.filter((e) => e.id.startsWith('link-'))
    if (links.length) {
      // current data: all service links are unverified -> dotted + reduced opacity
      const unverified = links.filter((e) => e.style?.strokeDasharray === '1 4')
      expect(unverified.length).toBeGreaterThan(0)
      for (const e of unverified) expect(e.style.opacity).toBeLessThan(1)
    }
  })

  it('applies a layout override to a card position', () => {
    const g = buildGraph(data, { mode: 'dev', layout: { 'be-orders': { x: 4321, y: -1234 } } })
    const n = g.nodes.find((x) => x.id === 'be-orders')
    if (n) expect(n.position).toEqual({ x: 4321, y: -1234 })
  })

  it('applies an admin geometry override to a region box', () => {
    const ov = { x: 1000, y: -500, w: 640, h: 480 }
    const g = buildGraph(data, { mode: 'dev', layout: { 'region-CSS': ov } })
    const reg = g.nodes.find((n) => n.id === 'region-CSS')
    if (reg) {
      expect(reg.position).toEqual({ x: ov.x, y: ov.y })
      expect(reg.style.width).toBe(ov.w)
      expect(reg.style.height).toBe(ov.h)
    }
  })

  it('does not balloon a cluster box when one member is dragged far out (outlier-trimmed bounds)', () => {
    const baseline = buildGraph(data, { mode: 'dev' }).nodes.find((n) => n.id === 'region-Resources')
    const dragged = buildGraph(data, { mode: 'dev', layout: { 'be-orders': { x: 99999, y: 0 } } }).nodes.find((n) => n.id === 'region-Resources')
    if (baseline && dragged) {
      // the moved card must not stretch the outline across the canvas — width stays near baseline
      expect(dragged.style.width).toBeLessThan(baseline.style.width + 600)
    }
  })

  it('resolveClusters falls back to the built-in default when config omits clusters', () => {
    expect(resolveClusters(undefined)).toBe(DEFAULT_CLUSTERS)
    expect(resolveClusters({})).toBe(DEFAULT_CLUSTERS)
    expect(resolveClusters({ clusters: [] })).toBe(DEFAULT_CLUSTERS) // empty → defaults
    const custom = [{ label: 'X', match: [], fallback: true }]
    expect(resolveClusters({ clusters: custom })).toBe(custom)
  })

  it('renders a region per configured cluster', () => {
    const g = buildGraph(data, { mode: 'dev', facets: groups(...ALL_CLUSTERS) })
    const regions = new Set(g.nodes.filter((n) => n.type === 'region').map((n) => n.data.label))
    // every lane that actually has members draws its outline; an empty lane legitimately draws none
    const populated = LANES.filter((label) => g.nodes.some((n) => n.data?.repo && n.data.cluster === label))
    for (const label of populated) expect(regions.has(label), label).toBe(true)
    expect(regions.size).toBeGreaterThan(0)
  })

  it('a custom cluster config remaps membership, lanes and colors', () => {
    // Re-cluster the committed estate under labels it has never seen: every owner topic the data
    // uses is routed into one lane, so the whole estate lands there and the configured labels — not
    // the committed ones — are what render.
    const owners = [...new Set(data.inventory.map((e) => e.owner).filter(Boolean))]
    const custom = {
      ...config,
      clusters: [
        { label: 'Everything', match: owners, color: '#1565c0', defaultOn: true, anchor: -400, dir: -1 },
        { label: 'Devices', match: ['NOTHING-MATCHES-THIS'], color: '#2e7d32', defaultOn: true, anchor: 400, dir: 1 },
        { label: 'Unscoped', match: [], color: '#777', fallback: true, center: true, defaultOn: true },
      ],
    }
    const g = buildGraph({ ...data, config: custom }, { mode: 'dev', facets: groups('Everything', 'Devices', 'Unscoped') })
    const regions = g.nodes.filter((n) => n.type === 'region')
    const labels = new Set(regions.map((r) => r.data.label))
    // custom labels render; the committed taxonomy's do not
    expect(labels.has('Everything')).toBe(true)
    for (const old of LANES) expect(labels.has(old), old).toBe(false)
    // region color comes from the descriptor
    expect(regions.find((r) => r.data.label === 'Everything').data.color).toBe('#1565c0')
    expect(regions.length).toBeGreaterThan(0)
  })

  it('uses serviceId as the node id (folder stays a resolvable alias) when serviceId !== folder', () => {
    const d = {
      repos: [
        { folder: 'ui', kind: 'library', name: '@framework/ui', inventory: { name: 'ui', owner: 'CSS.SI' } },
        {
          folder: 'device-data-service',
          serviceId: 'device-data-ingestion',
          kind: 'service',
          name: '@meridian/device-data',
          inventory: { name: 'device-data-ingestion', owner: 'CSS.AT' },
          internalDeps: [{ name: '@framework/ui', version: '1.0.0' }],
        },
      ],
      inventory: [],
      backendTopology: {
        feBe: { 'device-data-service': ['be-orders'] },
        backends: [{ id: 'be-orders', label: 'orders-service', kind: 'backend', repo: 'orders-service' }],
      },
    }
    const g = buildGraph(d, { mode: 'dev' })
    const ids = new Set(g.nodes.map((n) => n.id))
    // (a) the card node id is the serviceId, and the old folder is NOT a node id
    expect(ids.has('device-data-ingestion')).toBe(true)
    expect(ids.has('device-data-service')).toBe(false)
    // (b) repo-derived edges use the serviceId as their source (feBe lookup stays folder-keyed)
    expect(g.edges.find((e) => e.id.startsWith('dep-'))?.source).toBe('device-data-ingestion')
    expect(g.edges.find((e) => e.id.startsWith('be-'))?.source).toBe('device-data-ingestion')
    // (c) no dangling edges
    for (const e of g.edges) {
      expect(ids.has(e.source), e.id).toBe(true)
      expect(ids.has(e.target), e.id).toBe(true)
    }
    // (d) folder->serviceId resolver: an old folder-keyed ?sel= / saved view still resolves to the node
    expect(nodeIdOf(d.repos[1])).toBe('device-data-ingestion')
    const resolve = (sel) => g.nodes.find((n) => n.type === 'card' && (n.id === sel || n.data.repo?.folder === sel || n.data.repo?.serviceId === sel))
    expect(resolve('device-data-service')?.id).toBe('device-data-ingestion')
    expect(resolve('device-data-ingestion')?.id).toBe('device-data-ingestion')
  })

  it('nodeIdOf falls back to the folder when no serviceId is present (byte-invariant)', () => {
    expect(nodeIdOf({ folder: 'skygate-client' })).toBe('skygate-client')
    expect(nodeIdOf({ folder: 'device-data-service', serviceId: 'device-data-ingestion' })).toBe('device-data-ingestion')
    // committed data carries no serviceId yet, so every repo card id is still its folder
    const g = buildGraph(data, { mode: 'dev', facets: groups(...ALL_CLUSTERS) })
    for (const n of g.nodes.filter((n) => n.type === 'card' && n.data.repo)) expect(n.id).toBe(nodeIdOf(n.data.repo))
  })
})
