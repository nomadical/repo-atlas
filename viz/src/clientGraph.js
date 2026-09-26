import dagre from '@dagrejs/dagre'
import { MarkerType } from '@xyflow/react'

// Per-client drill-down: screens (routes) → the endpoints they call → the backend serving each
// endpoint. Screen data comes from data.extras.screens.perRepo[folder] (scripts/screens-gather.mjs).
// An endpoint resolves to a backend by matching its swagger-link host, or the repo's apiUrl, against
// data.backendTopology hosts. Laid out left to right with dagre so shared endpoints fan in visibly.

const SIZE_BY_KIND = {
  screen: [230, 92],
  endpoint: [240, 56],
  backend: [210, 64],
}
const ROLES_SHOWN = 3
const SCREEN_EDGE_COLOR = '#00838f'
const BACKEND_EDGE_COLOR = '#fb8c00'

export function clientScreens(data, folder) {
  return data?.extras?.screens?.perRepo?.[folder] || null
}

// Which clients and screens use each design-system export: change-impact analysis for the
// design-system team. Takes data.extras.
export function componentAdoption(extras) {
  const perRepo = extras?.screens?.perRepo || {}
  const usageByComponent = new Map()
  for (const [folder, report] of Object.entries(perRepo)) {
    for (const screen of report.screens || []) {
      for (const component of screen.components || []) {
        if (!usageByComponent.has(component)) {
          usageByComponent.set(component, { clients: new Set(), screens: 0 })
        }
        const usage = usageByComponent.get(component)
        usage.clients.add(folder)
        usage.screens++
      }
    }
  }
  return [...usageByComponent.entries()]
    .map(([component, usage]) => ({ component, clients: [...usage.clients].sort(), screens: usage.screens }))
    .sort((a, b) => b.clients.length - a.clients.length || b.screens - a.screens || a.component.localeCompare(b.component))
}

// Hosts compare without protocol or path, and with environment segments collapsed to .{env}.
const normalizeHost = (host) =>
  String(host || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.(dev|test|pre|prod|demo|poc|nonprod|sandbox|e2e)(?=\.)/g, '.{env}')
    .toLowerCase()

function hostOfUrl(url) {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

// Returns { backendOf(endpoint) -> backend | null, backends }.
export function clientBackendResolver(data, folder) {
  const report = clientScreens(data, folder)
  const repo = data?.repos?.find((candidate) => candidate.folder === folder)
  const backends = data?.backendTopology?.backends || []
  const links = report?.endpointLinks || {}
  const apiHost = repo?.apiUrl ? normalizeHost(repo.apiUrl) : null
  const cache = new Map()
  const backendOf = (endpoint) => {
    if (cache.has(endpoint)) return cache.get(endpoint)
    const linkHost = hostOfUrl(links[endpoint])
    const host = linkHost ? normalizeHost(linkHost) : apiHost
    const backend = (host && backends.find((b) => b.host && normalizeHost(b.host) === host)) || null
    cache.set(endpoint, backend)
    return backend
  }
  return { backendOf, backends }
}

// Distinct backend labels a screen's endpoints reach (the table's Backend column).
export function screenBackendLabels(screen, backendOf) {
  const labelById = new Map()
  for (const endpoint of screen.endpoints || []) {
    const backend = backendOf(endpoint)
    if (backend && !labelById.has(backend.id)) labelById.set(backend.id, backend.label)
  }
  return [...labelById.values()]
}

const arrowEdge = (source, target, color) => ({
  id: `${source}->${target}`,
  source,
  target,
  markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
  style: { stroke: color, strokeWidth: 1 },
})

// Two screens can share a component name (route wrappers), so duplicates get a numeric suffix
// instead of overwriting each other in dagre and in React keys.
function uniqueScreenId(screen, usedIds) {
  const base = 'screen:' + (screen.component || screen.name)
  let id = base
  for (let i = 2; usedIds.has(id); i++) id = base + ':' + i
  usedIds.add(id)
  return id
}

// Returns { nodes, edges, screenCount, endpointCount, backendCount, method } for one client, or
// null when it has no screen data.
export function buildClientGraph(data, folder) {
  const report = clientScreens(data, folder)
  if (!report || !report.screens?.length) return null
  const links = report.endpointLinks || {}
  const { backendOf } = clientBackendResolver(data, folder)

  const layoutGraph = new dagre.graphlib.Graph()
  layoutGraph.setDefaultEdgeLabel(() => ({}))
  layoutGraph.setGraph({
    rankdir: 'LR',
    nodesep: 22,
    ranksep: 200,
    marginx: 24,
    marginy: 24,
    ranker: 'tight-tree',
  })

  const nodes = []
  const edges = []
  const endpointNodeIds = new Map()
  const backendIds = new Set()

  const addNode = (id, data) => {
    nodes.push({ id, type: 'card', position: { x: 0, y: 0 }, data })
    const [width, height] = SIZE_BY_KIND[data.kind]
    layoutGraph.setNode(id, { width, height })
  }
  const addEdge = (source, target, color) => {
    edges.push(arrowEdge(source, target, color))
    layoutGraph.setEdge(source, target)
  }

  const backendNodeId = (backend) => {
    const id = 'be:' + backend.id
    if (backendIds.has(backend.id)) return id
    backendIds.add(backend.id)
    addNode(id, { kind: 'backend', title: backend.label, subtitle: backend.host || null, backend })
    return id
  }

  // Each endpoint is added once, together with its edge to the backend serving it.
  const endpointNodeId = (endpoint) => {
    if (endpointNodeIds.has(endpoint)) return endpointNodeIds.get(endpoint)
    const id = 'ep:' + endpoint
    endpointNodeIds.set(endpoint, id)
    addNode(id, {
      kind: 'endpoint',
      title: endpoint,
      subtitle: links[endpoint] ? 'swagger ↗' : null,
      endpoint,
      link: links[endpoint] || null,
    })
    const backend = backendOf(endpoint)
    if (backend) addEdge(id, backendNodeId(backend), BACKEND_EDGE_COLOR)
    return id
  }

  const screenIds = new Set()
  for (const screen of report.screens) {
    const id = uniqueScreenId(screen, screenIds)
    addNode(id, {
      kind: 'screen',
      title: screen.name,
      subtitle: screen.path || screen.file || null,
      chips: (screen.roles || []).slice(0, ROLES_SHOWN),
      screen,
    })
    for (const endpoint of screen.endpoints || []) {
      addEdge(id, endpointNodeId(endpoint), SCREEN_EDGE_COLOR)
    }
  }

  dagre.layout(layoutGraph)
  for (const node of nodes) {
    const [width, height] = SIZE_BY_KIND[node.data.kind]
    const center = layoutGraph.node(node.id)
    node.position = { x: center.x - width / 2, y: center.y - height / 2 }
  }

  return {
    nodes,
    edges,
    screenCount: report.screens.length,
    endpointCount: endpointNodeIds.size,
    backendCount: backendIds.size,
    method: report.method,
  }
}
