import { useEffect, useMemo, useState } from 'react'
import { ReactFlow, Background, Controls, MiniMap } from '@xyflow/react'
import CardNode from './CardNode.jsx'
import RegionNode from './RegionNode.jsx'
import { KIND } from './graph.js'
import { buildClientGraph, clientScreens, clientBackendResolver, screenBackendLabels } from './clientGraph.js'
import { Icon } from './icons.jsx'

const nodeTypes = { card: CardNode, region: RegionNode }

// Endpoint chips — clickable when a swagger deep-link exists for the path.
function EndpointChips({ endpoints, links }) {
  if (!endpoints?.length) return <span className="muted">—</span>
  return (
    <div className="chiprow">
      {endpoints.map((e) =>
        links?.[e] ? (
          <a
            key={e}
            className="ext-chip mono"
            href={links[e]}
            target="_blank"
            rel="noreferrer"
            title={`Open API docs for ${e}`}
            onClick={(ev) => ev.stopPropagation()}
          >
            {e}
          </a>
        ) : (
          <span key={e} className="ext-chip mono" title={e}>
            {e}
          </span>
        ),
      )}
    </div>
  )
}

// Table of a client's screens — the comfortable default for reading per-screen endpoint usage.
function ScreensTable({ rep, onSelectScreen, clientTitle, backendOf }) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState({ key: 'name', dir: 1 })
  const links = rep.endpointLinks || {}
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let r = rep.screens
    if (needle) {
      r = r.filter((s) =>
        [s.name, s.path, (s.paths || []).join(' '), (s.roles || []).join(' '), (s.endpoints || []).join(' '), (s.components || []).join(' ')]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    }
    const val = (s) => (sort.key === 'endpoints' ? s.endpoints?.length || 0 : sort.key === 'route' ? s.path || '' : s.name || '')
    return [...r].sort((a, b) => {
      const av = val(a)
      const bv = val(b)
      return (typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))) * sort.dir
    })
  }, [rep.screens, q, sort])

  const Th = ({ k, children }) => (
    <th className={'sortable' + (sort.key === k ? ' sorted' : '')} onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? -s.dir : 1 }))}>
      {children}
      {sort.key === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
    </th>
  )

  return (
    <div className="table-wrap">
      <div className="table-meta">
        <input className="table-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter screens, routes, endpoints, components…" />
        <span className="muted small">
          {rows.length} of {rep.screens.length} screens
        </span>
      </div>
      <table className="inv-table">
        <thead>
          <tr>
            <Th k="name">Screen</Th>
            <Th k="route">Route</Th>
            <th>Roles</th>
            <th>UI components</th>
            <th>Backend</th>
            <Th k="endpoints">Endpoints</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr
              key={s.component || s.name}
              onClick={() => onSelectScreen?.(s, clientTitle)}
              tabIndex={0}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault()
                  onSelectScreen?.(s, clientTitle)
                }
              }}
            >
              <td>
                <div className="screen-name">{s.name}</div>
                {s.file ? <div className="muted small mono">{s.file}</div> : null}
              </td>
              <td className="mono small">{(s.paths?.length ? s.paths : s.path ? [s.path] : []).join(', ') || <span className="muted">—</span>}</td>
              <td className="small">
                {s.roles?.length ? (
                  <div className="chiprow">
                    {s.roles.map((r) => (
                      <span key={r} className="mod-chip">
                        {r}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td className="small">
                {s.components?.length ? (
                  <div className="chiprow">
                    {s.components.map((c) => (
                      <span key={c} className="mod-chip ui-chip">
                        {c}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td className="small">
                {(() => {
                  const bes = screenBackendLabels(s, backendOf)
                  return bes.length ? (
                    <div className="chiprow">
                      {bes.map((b) => (
                        <span key={b} className="mod-chip be-chip">
                          {b}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="muted">—</span>
                  )
                })()}
              </td>
              <td className="small">
                <EndpointChips endpoints={s.endpoints} links={links} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ScreensGraph({ data, folder, dark, onSelectScreen, clientTitle }) {
  const graph = useMemo(() => buildClientGraph(data, folder), [data, folder])
  if (!graph) return null
  const onNodeClick = (_, node) => {
    if (node.data.kind === 'screen') onSelectScreen?.(node.data.screen, clientTitle)
    else if (node.data.kind === 'endpoint' && node.data.link) window.open(node.data.link, '_blank', 'noopener')
  }
  return (
    <ReactFlow
      nodes={graph.nodes}
      edges={graph.edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      nodesDraggable={false}
      fitView
      fitViewOptions={{ padding: 0.12 }}
      minZoom={0.1}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={18} color={dark ? '#223052' : '#e6e8ee'} />
      <MiniMap pannable zoomable nodeColor={(n) => KIND[n.data?.kind]?.color || '#bbb'} />
      <Controls />
    </ReactFlow>
  )
}

// Per-client drill-down: screens (routes) and the backend endpoints each one calls. Table by default
// (comfortable for reading); a graph toggle shows the same screen→endpoint relationships visually.
export default function ClientDetailView({ data, folder, title, dark, onBack, onSelectScreen }) {
  const [mode, setMode] = useState('table')
  // Esc exits the drill-down back to the map (in addition to the Back button).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onBack?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])
  const rep = clientScreens(data, folder)
  const { backendOf } = useMemo(() => clientBackendResolver(data, folder), [data, folder])
  const counts = useMemo(() => {
    if (!rep?.screens?.length) return null
    const eps = new Set()
    const bes = new Set()
    const comps = new Set()
    for (const s of rep.screens) {
      for (const e of s.endpoints || []) {
        eps.add(e)
        const be = backendOf(e)
        if (be) bes.add(be.id)
      }
      for (const c of s.components || []) comps.add(c)
    }
    return { screens: rep.screens.length, endpoints: eps.size, backends: bes.size, components: comps.size }
  }, [rep, backendOf])

  return (
    <div className="canvas client-detail">
      <div className="client-detail-bar">
        <button className="btn" onClick={onBack} title="Back to the map (Esc)">
          <Icon name="close" /> Back to map
        </button>
        <span className="client-detail-title">{title || folder}</span>
        {counts ? (
          <span className="client-detail-meta">
            {counts.screens} screens · {counts.endpoints} endpoints · {counts.backends} backends · {counts.components} UI components
            {rep.method === 'folder' ? ' · folder-inferred' : ''}
          </span>
        ) : null}
        {counts ? (
          <div className="seg-toggle" role="tablist" aria-label="Drill-down view">
            <button className={'seg' + (mode === 'table' ? ' on' : '')} onClick={() => setMode('table')} role="tab" aria-selected={mode === 'table'}>
              Table
            </button>
            <button className={'seg' + (mode === 'graph' ? ' on' : '')} onClick={() => setMode('graph')} role="tab" aria-selected={mode === 'graph'}>
              Graph
            </button>
          </div>
        ) : null}
      </div>

      {!counts ? (
        <div className="loading">
          <span>No screen data extracted for this client yet.</span>
        </div>
      ) : mode === 'table' ? (
        <ScreensTable rep={rep} onSelectScreen={onSelectScreen} clientTitle={title || folder} backendOf={backendOf} />
      ) : (
        <>
          <ScreensGraph data={data} folder={folder} dark={dark} onSelectScreen={onSelectScreen} clientTitle={title || folder} />
          <div className="legend client-legend">
            <div className="legend-cap">This view</div>
            <div className="legend-item">
              <span className="dot" style={{ background: KIND.screen.color }} /> Screen (route)
            </div>
            <div className="legend-item">
              <span className="dot" style={{ background: KIND.endpoint.color }} /> Endpoint
            </div>
            <div className="legend-item">
              <span className="dot" style={{ background: KIND.backend.color }} /> Backend
            </div>
            <div className="legend-item legend-note">screen → endpoint → backend. Click an endpoint to open its API docs.</div>
          </div>
        </>
      )}
    </div>
  )
}
