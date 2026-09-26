import { useEffect, useMemo, useState } from 'react'
import { ReactFlow, Background, Controls, MiniMap } from '@xyflow/react'
import CardNode from './CardNode.jsx'
import RegionNode from './RegionNode.jsx'
import { KIND } from './graph.js'
import { buildClientGraph, clientScreens, clientBackendResolver, screenBackendLabels } from './clientGraph.js'
import { Icon } from './icons.jsx'

const nodeTypes = { card: CardNode, region: RegionNode }
const FIT_VIEW_OPTIONS = { padding: 0.12 }
const MIN_ZOOM = 0.1
const BACKGROUND_GAP = 18
const BACKGROUND_COLOR_DARK = '#223052'
const BACKGROUND_COLOR_LIGHT = '#e6e8ee'
const MINIMAP_FALLBACK_COLOR = '#bbb'

const Dash = () => <span className="muted">—</span>

function ChipList({ items, chipClassName }) {
  if (!items?.length) return <Dash />
  return (
    <div className="chiprow">
      {items.map((item) => (
        <span key={item} className={chipClassName}>
          {item}
        </span>
      ))}
    </div>
  )
}

// Clickable when a swagger deep link exists for the endpoint.
function EndpointChips({ endpoints, links }) {
  if (!endpoints?.length) return <Dash />
  return (
    <div className="chiprow">
      {endpoints.map((endpoint) =>
        links?.[endpoint] ? (
          <a
            key={endpoint}
            className="ext-chip mono"
            href={links[endpoint]}
            target="_blank"
            rel="noreferrer"
            title={`Open API docs for ${endpoint}`}
            onClick={(event) => event.stopPropagation()}
          >
            {endpoint}
          </a>
        ) : (
          <span key={endpoint} className="ext-chip mono" title={endpoint}>
            {endpoint}
          </span>
        ),
      )}
    </div>
  )
}

function screenMatches(screen, needle) {
  return [
    screen.name,
    screen.path,
    (screen.paths || []).join(' '),
    (screen.roles || []).join(' '),
    (screen.endpoints || []).join(' '),
    (screen.components || []).join(' '),
  ]
    .join(' ')
    .toLowerCase()
    .includes(needle)
}

function screenSortValue(screen, key) {
  if (key === 'endpoints') return screen.endpoints?.length || 0
  if (key === 'route') return screen.path || ''
  return screen.name || ''
}

function routesOf(screen) {
  if (screen.paths?.length) return screen.paths
  return screen.path ? [screen.path] : []
}

function ScreenRow({ screen, links, backendOf, onSelect }) {
  const onKeyDown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onSelect()
  }
  return (
    <tr onClick={onSelect} tabIndex={0} onKeyDown={onKeyDown}>
      <td>
        <div className="screen-name">{screen.name}</div>
        {screen.file ? <div className="muted small mono">{screen.file}</div> : null}
      </td>
      <td className="mono small">{routesOf(screen).join(', ') || <Dash />}</td>
      <td className="small">
        <ChipList items={screen.roles} chipClassName="mod-chip" />
      </td>
      <td className="small">
        <ChipList items={screen.components} chipClassName="mod-chip ui-chip" />
      </td>
      <td className="small">
        <ChipList items={screenBackendLabels(screen, backendOf)} chipClassName="mod-chip be-chip" />
      </td>
      <td className="small">
        <EndpointChips endpoints={screen.endpoints} links={links} />
      </td>
    </tr>
  )
}

// The default drill-down view: comfortable for reading per-screen endpoint usage.
function ScreensTable({ rep, onSelectScreen, clientTitle, backendOf }) {
  const [filterText, setFilterText] = useState('')
  const [sort, setSort] = useState({ key: 'name', dir: 1 })
  const links = rep.endpointLinks || {}
  const rows = useMemo(() => {
    const needle = filterText.trim().toLowerCase()
    const matching = needle ? rep.screens.filter((screen) => screenMatches(screen, needle)) : rep.screens
    return [...matching].sort((a, b) => {
      const valueA = screenSortValue(a, sort.key)
      const valueB = screenSortValue(b, sort.key)
      const order =
        typeof valueA === 'number' ? valueA - valueB : String(valueA).localeCompare(String(valueB))
      return order * sort.dir
    })
  }, [rep.screens, filterText, sort])

  // Defined inside the component, so it is a new component type on every render and the header
  // cells remount each time.
  const Th = ({ k, children }) => (
    <th
      className={'sortable' + (sort.key === k ? ' sorted' : '')}
      onClick={() => setSort((current) => ({ key: k, dir: current.key === k ? -current.dir : 1 }))}
    >
      {children}
      {sort.key === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
    </th>
  )

  return (
    <div className="table-wrap">
      <div className="table-meta">
        <input
          className="table-filter"
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
          placeholder="Filter screens, routes, endpoints, components…"
        />
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
          {rows.map((screen) => (
            <ScreenRow
              key={screen.component || screen.name}
              screen={screen}
              links={links}
              backendOf={backendOf}
              onSelect={() => onSelectScreen?.(screen, clientTitle)}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ScreensGraph({ data, folder, dark, onSelectScreen, clientTitle }) {
  const graph = useMemo(() => buildClientGraph(data, folder), [data, folder])
  if (!graph) return null
  const onNodeClick = (_event, node) => {
    if (node.data.kind === 'screen') {
      onSelectScreen?.(node.data.screen, clientTitle)
    } else if (node.data.kind === 'endpoint' && node.data.link) {
      window.open(node.data.link, '_blank', 'noopener')
    }
  }
  return (
    <ReactFlow
      nodes={graph.nodes}
      edges={graph.edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      nodesDraggable={false}
      fitView
      fitViewOptions={FIT_VIEW_OPTIONS}
      minZoom={MIN_ZOOM}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={BACKGROUND_GAP} color={dark ? BACKGROUND_COLOR_DARK : BACKGROUND_COLOR_LIGHT} />
      <MiniMap
        pannable
        zoomable
        nodeColor={(node) => KIND[node.data?.kind]?.color || MINIMAP_FALLBACK_COLOR}
      />
      <Controls />
    </ReactFlow>
  )
}

function countScreenUsage(screens, backendOf) {
  const endpoints = new Set()
  const backends = new Set()
  const components = new Set()
  for (const screen of screens) {
    for (const endpoint of screen.endpoints || []) {
      endpoints.add(endpoint)
      const backend = backendOf(endpoint)
      if (backend) backends.add(backend.id)
    }
    for (const component of screen.components || []) components.add(component)
  }
  return {
    screens: screens.length,
    endpoints: endpoints.size,
    backends: backends.size,
    components: components.size,
  }
}

function GraphLegend() {
  return (
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
      <div className="legend-item legend-note">
        screen → endpoint → backend. Click an endpoint to open its API docs.
      </div>
    </div>
  )
}

function ModeToggle({ mode, setMode }) {
  const modeButton = (value, label) => (
    <button
      className={'seg' + (mode === value ? ' on' : '')}
      onClick={() => setMode(value)}
      role="tab"
      aria-selected={mode === value}
    >
      {label}
    </button>
  )
  return (
    <div className="seg-toggle" role="tablist" aria-label="Drill-down view">
      {modeButton('table', 'Table')}
      {modeButton('graph', 'Graph')}
    </div>
  )
}

// Per-client drill-down: its screens (routes) and the backend endpoints each one calls, as a table
// or as a graph of the same relationships.
export default function ClientDetailView({ data, folder, title, dark, onBack, onSelectScreen }) {
  const [mode, setMode] = useState('table')
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onBack?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onBack])
  const rep = clientScreens(data, folder)
  const { backendOf } = useMemo(() => clientBackendResolver(data, folder), [data, folder])
  const counts = useMemo(() => {
    if (!rep?.screens?.length) return null
    return countScreenUsage(rep.screens, backendOf)
  }, [rep, backendOf])
  const clientTitle = title || folder

  const renderBody = () => {
    if (!counts) {
      return (
        <div className="loading">
          <span>No screen data extracted for this client yet.</span>
        </div>
      )
    }
    if (mode === 'table') {
      return (
        <ScreensTable
          rep={rep}
          onSelectScreen={onSelectScreen}
          clientTitle={clientTitle}
          backendOf={backendOf}
        />
      )
    }
    return (
      <>
        <ScreensGraph
          data={data}
          folder={folder}
          dark={dark}
          onSelectScreen={onSelectScreen}
          clientTitle={clientTitle}
        />
        <GraphLegend />
      </>
    )
  }

  return (
    <div className="canvas client-detail">
      <div className="client-detail-bar">
        <button className="btn" onClick={onBack} title="Back to the map (Esc)">
          <Icon name="close" /> Back to map
        </button>
        <span className="client-detail-title">{clientTitle}</span>
        {counts ? (
          <span className="client-detail-meta">
            {counts.screens} screens · {counts.endpoints} endpoints · {counts.backends} backends ·{' '}
            {counts.components} UI components
            {rep.method === 'folder' ? ' · folder-inferred' : ''}
          </span>
        ) : null}
        {counts ? <ModeToggle mode={mode} setMode={setMode} /> : null}
      </div>

      {renderBody()}
    </div>
  )
}
