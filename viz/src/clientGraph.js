import dagre from '@dagrejs/dagre'
import { MarkerType } from '@xyflow/react'

// Per-client drill-down graph: a three-tier trace — screens (routes) → the backend endpoints they
// call → the backend that serves each endpoint. Screen/endpoint data comes from
// data.extras.screens.perRepo[folder] (scripts/screens-gather.mjs); the endpoint→backend resolution
// matches the endpoint's swagger-link host (or the repo's apiUrl) against data.backendTopology hosts.
// Laid out left→right with dagre so shared endpoints/backends fan in visibly. Read-only.

const SCREEN_W = 230,
  SCREEN_H = 92,
  EP_W = 240,
  EP_H = 56,
  BE_W = 210,
  BE_H = 64

export function clientScreens(data, folder) {
  return data?.extras?.screens?.perRepo?.[folder] || null
}

// Design-system adoption: invert the per-screen component usage into "which clients/screens use each
// @framework/ui export" — change-impact analysis for the design-system team. Takes data.extras.
export function componentAdoption(extras) {
  const per = extras?.screens?.perRepo || {}
  const map = new Map() // component -> { clients:Set, screens:number }
  for (const [folder, rep] of Object.entries(per)) {
    for (const s of rep.screens || []) {
      for (const c of s.components || []) {
        let e = map.get(c)
        if (!e) {
          e = { clients: new Set(), screens: 0 }
          map.set(c, e)
        }
        e.clients.add(folder)
        e.screens++
      }
    }
  }
  return [...map.entries()]
    .map(([component, e]) => ({ component, clients: [...e.clients].sort(), screens: e.screens }))
    .sort((a, b) => b.clients.length - a.clients.length || b.screens - a.screens || a.component.localeCompare(b.component))
}

// Normalize a host for comparison: drop protocol/path, collapse env segments to .{env}, lowercase.
const normHost = (h) =>
  String(h || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.(dev|test|pre|prod|demo|poc|nonprod|sandbox|e2e)(?=\.)/g, '.{env}')
    .toLowerCase()

// Resolve each endpoint of a client to the backend node that serves it. Returns
// { backendOf(endpoint) -> backend|null, backends: [used backend nodes] }.
export function clientBackendResolver(data, folder) {
  const rep = clientScreens(data, folder)
  const repo = data?.repos?.find((r) => r.folder === folder)
  const backends = data?.backendTopology?.backends || []
  const links = rep?.endpointLinks || {}
  const apiHost = repo?.apiUrl ? normHost(repo.apiUrl) : null
  const cache = new Map()
  const backendOf = (endpoint) => {
    if (cache.has(endpoint)) return cache.get(endpoint)
    let host = null
    const link = links[endpoint]
    if (link) {
      try {
        host = new URL(link).host
      } catch {
        /* not a full URL */
      }
    }
    const nh = host ? normHost(host) : apiHost
    const be = (nh && backends.find((b) => b.host && normHost(b.host) === nh)) || null
    cache.set(endpoint, be)
    return be
  }
  return { backendOf, backends }
}

// Distinct backend labels a screen's endpoints reach (for the table's Backend column).
export function screenBackendLabels(screen, backendOf) {
  const seen = new Map()
  for (const e of screen.endpoints || []) {
    const be = backendOf(e)
    if (be && !seen.has(be.id)) seen.set(be.id, be.label)
  }
  return [...seen.values()]
}

// Build { nodes, edges, screenCount, endpointCount, backendCount } for one client, or null if no data.
export function buildClientGraph(data, folder) {
  const rep = clientScreens(data, folder)
  if (!rep || !rep.screens?.length) return null
  const links = rep.endpointLinks || {}
  const { backendOf } = clientBackendResolver(data, folder)

  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 22, ranksep: 200, marginx: 24, marginy: 24, ranker: 'tight-tree' })

  const nodes = []
  const edges = []
  const endpointIds = new Map() // endpoint path -> node id
  const backendIds = new Set() // backend id already added
  const dimOf = (kind) => (kind === 'endpoint' ? [EP_W, EP_H] : kind === 'backend' ? [BE_W, BE_H] : [SCREEN_W, SCREEN_H])

  const addBackendNode = (be) => {
    const id = 'be:' + be.id
    if (!backendIds.has(be.id)) {
      backendIds.add(be.id)
      nodes.push({ id, type: 'card', position: { x: 0, y: 0 }, data: { kind: 'backend', title: be.label, subtitle: be.host || null, backend: be } })
      g.setNode(id, { width: BE_W, height: BE_H })
    }
    return id
  }

  const epId = (e) => {
    if (endpointIds.has(e)) return endpointIds.get(e)
    const id = 'ep:' + e
    endpointIds.set(e, id)
    nodes.push({
      id,
      type: 'card',
      position: { x: 0, y: 0 },
      data: { kind: 'endpoint', title: e, subtitle: links[e] ? 'swagger ↗' : null, endpoint: e, link: links[e] || null },
    })
    g.setNode(id, { width: EP_W, height: EP_H })
    // endpoint → backend (resolved once per endpoint)
    const be = backendOf(e)
    if (be) {
      const bid = addBackendNode(be)
      edges.push({
        id: `${id}->${bid}`,
        source: id,
        target: bid,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#fb8c00', width: 16, height: 16 },
        style: { stroke: '#fb8c00', strokeWidth: 1 },
      })
      g.setEdge(id, bid)
    }
    return id
  }

  const screenIds = new Set()
  for (const s of rep.screens) {
    // two screens can share a component name (route wrappers) — suffix duplicates so neither
    // silently overwrites the other in dagre / React keys
    let id = 'screen:' + (s.component || s.name)
    for (let i = 2; screenIds.has(id); i++) id = 'screen:' + (s.component || s.name) + ':' + i
    screenIds.add(id)
    nodes.push({
      id,
      type: 'card',
      position: { x: 0, y: 0 },
      data: { kind: 'screen', title: s.name, subtitle: s.path || s.file || null, chips: (s.roles || []).slice(0, 3), screen: s },
    })
    g.setNode(id, { width: SCREEN_W, height: SCREEN_H })
    for (const e of s.endpoints || []) {
      const t = epId(e)
      edges.push({
        id: `${id}->${t}`,
        source: id,
        target: t,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#00838f', width: 16, height: 16 },
        style: { stroke: '#00838f', strokeWidth: 1 },
      })
      g.setEdge(id, t)
    }
  }

  dagre.layout(g)
  for (const n of nodes) {
    const [w, h] = dimOf(n.data.kind)
    const p = g.node(n.id)
    n.position = { x: p.x - w / 2, y: p.y - h / 2 }
  }

  return { nodes, edges, screenCount: rep.screens.length, endpointCount: endpointIds.size, backendCount: backendIds.size, method: rep.method }
}
