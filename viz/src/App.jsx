import { useEffect, useMemo, useRef, useState, useCallback, lazy, Suspense } from 'react'
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import CardNode from './CardNode.jsx'
import RegionNode from './RegionNode.jsx'
import {
  buildGraph,
  KIND,
  LAYERS,
  resolveClusters,
  DEFAULT_CLUSTERS,
  matchInventory,
  uiPackagesOf,
  uiHubFoldersOf,
  coversAll,
} from './graph.js'
import { edgeTypes } from './floating.jsx'
import { authEnabled, relogin, isAdmin } from './auth.js'
import { getData, decryptData } from './data.js'
import Gate from './Gate.jsx'
import { Legend, LegendOverlay } from './Legend.jsx'
import Details from './Details.jsx'
import { getHelperLines, HelperLines } from './HelperLines.jsx'
import { Icon } from './icons.jsx'
import ContextMenu from './ContextMenu.jsx'
import EmbedDialog from './app/EmbedDialog.jsx'
import FiltersMenu from './app/FiltersMenu.jsx'
import {
  Brand,
  DetailSwitch,
  EmbedToolbarActions,
  GroupByMenu,
  HealthButton,
  MoreMenu,
  SearchBox,
  ThemeToggle,
  ToolbarActions,
  UserChip,
  ViewMenu,
  ViewsMenu,
} from './app/Toolbar.jsx'
import { contextMenuItems } from './app/contextMenuItems.js'
import {
  EMPTY_LAYOUT,
  UNDO_LIMIT,
  normalizeLayout,
  regionBoundsAround,
  roundedPosition,
  withOverride,
  withoutOverride,
} from './app/layout.js'
import { clientScreenCount, findSelNode, singleLineTitle } from './app/nodes.js'
import { filterSummary } from './app/filterSummary.js'
import { pipelineHealth } from './app/pipelineHealth.js'
import {
  EMBED,
  VIEW_LABELS,
  defaultOnLabels,
  facetsFromParams,
  groupParamFor,
  hiddenEdgesFromParams,
  initialFlag,
  initialParams,
  initialString,
  initialView,
  isSmallScreen,
  layersFromParams,
  parseViewParams,
  serializeViewParams,
  toGroupBy,
  toMode,
} from './app/urlState.js'

// Off-the-default-path UI is code-split: the Table/Matrix views load when the user switches to
// them, the Admin panel only for admins who open it.
const InventoryTable = lazy(() => import('./InventoryViews.jsx').then((m) => ({ default: m.InventoryTable })))
const MatrixView = lazy(() => import('./InventoryViews.jsx').then((m) => ({ default: m.MatrixView })))
const IntegrationsTable = lazy(() =>
  import('./InventoryViews.jsx').then((m) => ({ default: m.IntegrationsTable })),
)
const AdminPanel = lazy(() => import('./AdminPanel.jsx'))
const ClientDetailView = lazy(() => import('./ClientDetailView.jsx'))

const nodeTypes = { card: CardNode, region: RegionNode }
// Integration protocol -> arrow-type key (graph.js EDGE_TYPES), so the arrow toggles also filter
// the Integrations table's rows.
const PROTOCOL_EDGE = { REST: 'rest', Kafka: 'kafka' }
const GRID = 16 // snap-to-grid step in admin drag mode
const NO_HELPER = { h: undefined, v: undefined, color: undefined }
const DEFAULT_TITLE = 'Architecture Map'
const DEFAULT_DATA_STALE_DAYS = 7
const TABLE_VIEWS = ['table', 'matrix', 'integrations']

const PANEL_WIDTH_KEY = 'panelW'
const MIN_PANEL_WIDTH = 280
const DEFAULT_PANEL_WIDTH = 360
const SAVED_VIEWS_KEY = 'archmap-views'
const PASSPHRASE_KEY = 'archmap-pass'

const FRAME_DURATION = 450
const EMBED_FRAME_DELAY = 300
const EMPTY_GRAPH = {
  nodes: [],
  edges: [],
  facetOptions: { status: [], components: [] },
  edgeTypesPresent: [],
}
// One object for a missing config, so hooks that depend on it don't rerun every render.
const NO_CONFIG = {}
const EXPORT_BACKGROUND = { dark: '#0c1322', light: '#f4f6fa' }
const MINIMAP_FALLBACK_COLOR = '#bbb'

function readPanelWidth() {
  const saved = Number(typeof localStorage !== 'undefined' && localStorage.getItem(PANEL_WIDTH_KEY))
  return saved >= MIN_PANEL_WIDTH ? saved : DEFAULT_PANEL_WIDTH
}

// Saved views are per user (localStorage); sharing goes through the URL / Copy link instead.
function readSavedViews() {
  try {
    const saved = JSON.parse(
      (typeof localStorage !== 'undefined' && localStorage.getItem(SAVED_VIEWS_KEY)) || '[]',
    )
    return Array.isArray(saved) ? saved : []
  } catch {
    return []
  }
}

function toggledIn(set, value) {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

const uniqueValues = (values) => [...new Set(values.filter(Boolean))]

const sortedKey = (set) => [...set].sort().join(',')

// Changes whenever the canvas must remount (it keys the <ReactFlow> wrapper).
function canvasKey({ layers, viewMode, facets, hiddenEdges, generatedAt }) {
  const layerBits = LAYERS.map((layer) => (layers[layer.key] ? 1 : 0)).join('')
  const facetKey = [facets.group, facets.status, facets.health, facets.hidden].map(sortedKey).join('|')
  return `${layerBits}-${viewMode}-${facetKey}-${sortedKey(hiddenEdges)}-${generatedAt || ''}`
}

// Region boxes become movable/resizable for admins, persisting their geometry via onResize.
function withRegionEditing(nodes, admin, setRegionGeom) {
  return nodes.map((node) => {
    if (node.type !== 'region') return node
    return {
      ...node,
      draggable: admin,
      selectable: admin,
      focusable: admin,
      data: { ...node.data, editable: admin, onResize: (geom) => setRegionGeom(node.id, geom) },
    }
  })
}

// The focused nodes plus their direct neighbours, and the edges between them.
function litAround(focusNodes, edges) {
  const litNodes = new Set(focusNodes)
  const litEdges = new Set()
  for (const edge of edges) {
    if (!focusNodes.has(edge.source) && !focusNodes.has(edge.target)) continue
    litEdges.add(edge.id)
    litNodes.add(edge.source)
    litNodes.add(edge.target)
  }
  return { ln: litNodes, le: litEdges }
}

const focusClass = (litSet, id) => (litSet.has(id) ? 'lit' : 'dim')

// The PNG file name: the title slugified, falling back to the project name.
function exportFileName(title) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (slug || 'repo-atlas') + '.png'
}

function downloadHref(href, fileName) {
  const link = document.createElement('a')
  link.href = href
  link.download = fileName
  link.click()
}

const errorText = (error, maxLength) => String(error.message || error).slice(0, maxLength)

// A Table/Matrix/Integrations row selected into the Details panel.
function inventorySelection(entry) {
  let kind = 'component'
  if (entry.type === 'Client') kind = 'client'
  else if (/third/i.test(entry.type)) kind = 'external'
  return { title: entry.name, kind, subtitle: entry.owner, inventory: entry }
}

function Spinner({ label }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </div>
  )
}

function AccessDenied({ dark, reason }) {
  return (
    <div className={'app' + (dark ? ' dark' : '')}>
      <div className="loading" role="alert">
        <div>
          <p>
            <b>You're signed in, but your account can't read the architecture data.</b>
          </p>
          <p>
            The data API requires an access role ({reason}). Ask IT to assign it to your account, then{' '}
            <button className="btn" onClick={() => location.reload()}>
              reload
            </button>
            .
          </p>
        </div>
      </div>
    </div>
  )
}

function TableViews({
  view,
  facetInventory,
  visibleIntegrations,
  data,
  query,
  config,
  externalsByRepo,
  setSel,
}) {
  const onSelect = (entry) => setSel(inventorySelection(entry))
  let table
  if (view === 'matrix') {
    table = <MatrixView inventory={facetInventory} query={query} onSelect={onSelect} config={config} />
  } else if (view === 'integrations') {
    table = (
      <IntegrationsTable
        integrations={visibleIntegrations}
        inventory={data?.inventory || []}
        query={query}
        onSelect={onSelect}
      />
    )
  } else {
    table = (
      <InventoryTable
        inventory={facetInventory}
        query={query}
        onSelect={onSelect}
        externals={externalsByRepo}
        docSearchUrl={config?.docSearchUrl}
      />
    )
  }
  return <Suspense fallback={<Spinner />}>{table}</Suspense>
}

// Shown on the canvas while the admin layout differs from the saved one or has overrides.
function LayoutPill({ layoutDirty, autoArrange, openAdmin }) {
  return (
    <div className="layout-pill">
      <span className="layout-pill-txt">
        {layoutDirty ? <Icon name="dot" className="pill-dot" /> : null}{' '}
        {layoutDirty ? 'Layout changed' : 'Custom layout'}
      </span>
      <button className="btn ghost" onClick={autoArrange} title="Re-flow this view to the automatic layout">
        Auto-arrange
      </button>
      {layoutDirty ? (
        <button
          className="btn primary"
          onClick={openAdmin}
          title="Open Admin to save the layout to config.json"
        >
          Save…
        </button>
      ) : null}
    </div>
  )
}

export default function App() {
  const [data, setData] = useState(null)
  // Detail layers are additive and seeded from the URL.
  const [layers, setLayers] = useState(() => layersFromParams(initialParams))
  const toggleLayer = useCallback((key, on) => setLayers((current) => ({ ...current, [key]: on })), [])
  const [view, setView] = useState(initialView)
  const [sel, setSel] = useState(null)
  // Graph lane grouping. Layout-only: the team clusters stay the Group filter, so grouping and
  // filtering compose.
  const [groupBy, setGroupBy] = useState(() => toGroupBy(initialString('by', 'team')))
  // Per-client drill-down: when set, ClientDetailView for this repo folder replaces the body.
  const [clientId, setClientId] = useState(() => initialString('client', '') || null)
  const [busy, setBusy] = useState(null)
  const [toast, setToast] = useState(null)
  const [query, setQuery] = useState('')
  const [compFilter, setCompFilter] = useState('') // text filter inside the Components list
  // Faceted filters: OR within a dimension, AND across. Absent from the URL, `group` falls back to
  // the default-on clusters.
  const [facets, setFacets] = useState(() =>
    facetsFromParams(initialParams, defaultOnLabels(DEFAULT_CLUSTERS)),
  )
  const toggleFacet = useCallback(
    (dimension, value) =>
      setFacets((current) => ({ ...current, [dimension]: toggledIn(current[dimension], value) })),
    [],
  )
  // Bulk show/hide for the components list; `names` is whatever the list currently shows.
  const setComponentsHidden = useCallback((names, hide) => {
    const keys = names.map((name) => name.toLowerCase())
    setFacets((current) => {
      const hidden = new Set(current.hidden)
      for (const key of keys) {
        if (hide) hidden.add(key)
        else hidden.delete(key)
      }
      return { ...current, hidden }
    })
  }, [])
  // Edge-type keys the user has hidden (empty = show every arrow).
  const [hiddenEdges, setHiddenEdges] = useState(() => hiddenEdgesFromParams(initialParams))
  const toggleEdge = useCallback((key) => setHiddenEdges((current) => toggledIn(current, key)), [])
  const [showHealth, setShowHealth] = useState(false)
  // The health popover isn't a Dropdown, so it needs its own outside-click / Escape dismissal.
  const healthRef = useRef(null)
  useEffect(() => {
    if (!showHealth) return
    const onMouseDown = (event) => {
      if (healthRef.current && !healthRef.current.contains(event.target)) setShowHealth(false)
    }
    const onKeyDown = (event) => event.key === 'Escape' && setShowHealth(false)
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [showHealth])
  const [showLegend, setShowLegend] = useState(false)
  const [showEmbed, setShowEmbed] = useState(false)
  const [showAdmin, setShowAdmin] = useState(false)
  const [layout, setLayout] = useState(EMPTY_LAYOUT) // admin drag overrides per mode
  const [savedLayout, setSavedLayout] = useState(EMPTY_LAYOUT) // last persisted layout, for dirty tracking
  const [helper, setHelper] = useState(NO_HELPER) // alignment guide lines while dragging
  const [ctx, setCtx] = useState(null) // context menu target: { x, y, node }, node null = pane
  const rfRef = useRef(null) // ReactFlow instance
  const layoutUndo = useRef([]) // prior layout snapshots for Cmd/Ctrl+Z
  const pushUndo = useCallback(() => {
    layoutUndo.current.push(layout)
    if (layoutUndo.current.length > UNDO_LIMIT) layoutUndo.current.shift()
  }, [layout])
  const [panelW, setPanelW] = useState(readPanelWidth)
  // Each saved view is a query string from buildViewParams(). Card positions are not saved.
  const [views, setViews] = useState(readSavedViews)
  const persistViews = useCallback((next) => {
    setViews(next)
    try {
      localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(next))
    } catch {}
  }, [])

  const [enc, setEnc] = useState(null) // encrypted envelope awaiting a passphrase
  const [gateError, setGateError] = useState(false)
  const [gateBusy, setGateBusy] = useState(false)
  const [denied, setDenied] = useState(null) // signed in but missing the read role
  const load = useCallback(() => {
    const showData = async (result) => {
      if (result.data) return setData(result.data)
      setEnc(result.encrypted)
      // unlock silently on revisits
      const savedPassphrase = localStorage.getItem(PASSPHRASE_KEY)
      if (!savedPassphrase) return
      try {
        setData(await decryptData(result.encrypted, savedPassphrase))
      } catch {
        localStorage.removeItem(PASSPHRASE_KEY)
      }
    }
    const showError = (error) => {
      // A 401 here means the token refresh failed: the session expired.
      if (error?.unauthorized && authEnabled()) {
        setToast('Session expired — signing in again…')
        relogin()
        return
      }
      if (error?.forbidden) {
        setDenied(String(error.message || 'access denied'))
        return
      }
      setToast('Failed to load data: ' + error)
    }
    return getData().then(showData).catch(showError)
  }, [])
  useEffect(() => {
    load()
  }, [load])
  // Escape clears the spotlight, selection and search, unless an overlay or menu owns it.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      if (showLegend || showAdmin) return // those handle their own Escape
      // Dismiss the embed dialog / context menu without also clearing what's underneath.
      if (showEmbed) return setShowEmbed(false)
      if (ctx) return setCtx(null)
      setSel(null)
      setBlockFocus(null)
      setQuery('')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showLegend, showAdmin, showEmbed, ctx])
  const unlock = useCallback(
    async (passphrase) => {
      setGateBusy(true)
      setGateError(false)
      try {
        setData(await decryptData(enc, passphrase))
        try {
          localStorage.setItem(PASSPHRASE_KEY, passphrase)
        } catch {}
      } catch {
        setGateError(true)
      } finally {
        setGateBusy(false)
      }
    },
    [enc],
  )

  const [hoverId, setHoverId] = useState(null)
  const [blockFocus, setBlockFocus] = useState(null) // Set of node ids, or null
  const [dark, setDark] = useState(() => initialFlag('dark', false))
  const [mode, setMode] = useState(() => toMode(initialString('mode', 'dev')))
  // Non-admins are locked to the read-only overview regardless of the mode state or URL.
  const admin = isAdmin()
  const viewMode = admin ? mode : 'overview'
  const setRegionGeom = useCallback(
    (id, geom) => {
      pushUndo()
      setLayout((current) => withOverride(current, viewMode, id, geom))
    },
    [pushUndo, viewMode],
  )
  // The region reverts to its auto-computed bounds on the next build.
  const clearRegionGeom = useCallback(
    (id) => {
      pushUndo()
      setLayout((current) => withoutOverride(current, viewMode, id))
    },
    [pushUndo, viewMode],
  )
  // No-op when none of the region's members is on the canvas.
  const resizeRegionToFit = useCallback(
    (regionId, members) => {
      const nodes = rfRef.current?.getNodes?.() || []
      const memberIds = new Set(members || [])
      const cards = nodes.filter((node) => memberIds.has(node.id))
      if (!cards.length) return
      setRegionGeom(regionId, regionBoundsAround(cards))
    },
    [setRegionGeom],
  )

  // Published app config (config.json). Every field is optional and falls back to a built-in default.
  const config = data?.config || NO_CONFIG
  const clusterDefs = useMemo(() => resolveClusters(config), [config])
  const title = config.title || DEFAULT_TITLE
  const subtitle = config.subtitle || ''
  const logoUrl = config.logoUrl || ''
  // How old the generated data may get before the toolbar badge turns amber. Not the same as
  // `staleDays`, which is about repo commits (graph.js).
  const dataStaleDays =
    Number(config.dataStaleDays) > 0 ? Number(config.dataStaleDays) : DEFAULT_DATA_STALE_DAYS
  // dark/mode/view serialize against the config defaults, so switching back to a built-in default
  // writes an explicit param instead of an empty URL the config would revert on reload.
  const cfgDark = config.defaultTheme === 'dark'
  const cfgMode = config.defaultMode === 'overview' ? 'overview' : 'dev'
  const cfgView = VIEW_LABELS[config.defaultView] ? config.defaultView : 'graph'
  useEffect(() => {
    document.title = title
  }, [title])

  // Apply config defaults once, when the config first loads, and only where the URL didn't pin
  // the value: shared links win and in-session changes are never clobbered.
  const appliedDefaults = useRef(false)
  useEffect(() => {
    if (appliedDefaults.current || !data?.config) return
    appliedDefaults.current = true
    const loadedConfig = data.config
    const { defaultView, defaultMode, defaultTheme, clusters } = loadedConfig
    // small screens keep the touch-friendly Table
    if (!initialParams.has('view') && !isSmallScreen() && VIEW_LABELS[defaultView]) setView(defaultView)
    if (!initialParams.has('mode') && (defaultMode === 'overview' || defaultMode === 'dev'))
      setMode(defaultMode)
    if (!initialParams.has('dark') && (defaultTheme === 'dark' || defaultTheme === 'light')) {
      setDark(defaultTheme === 'dark')
    }
    // A fork's own clusters decide which groups start hidden.
    if (!initialParams.has('group') && Array.isArray(clusters) && clusters.length) {
      setFacets((current) => ({ ...current, group: new Set(defaultOnLabels(clusters)) }))
    }
    if (loadedConfig.layout && typeof loadedConfig.layout === 'object') {
      const curatedLayout = normalizeLayout(loadedConfig.layout)
      setLayout(curatedLayout)
      setSavedLayout(curatedLayout)
    }
  }, [data])

  // One build per change: buildGraph applies layers and facets itself, and reports the status
  // options present before the status filter ran, so the Filters menu needs no second build.
  const buildOpts = useMemo(
    () => ({ layers, facets, hiddenEdges, mode: viewMode, layout: layout[viewMode] || {}, groupBy }),
    [layers, facets, hiddenEdges, viewMode, layout, groupBy],
  )
  const graph = useMemo(() => (data ? buildGraph(data, buildOpts) : EMPTY_GRAPH), [data, buildOpts])
  const kindsPresent = useMemo(() => new Set(graph.nodes.map((node) => node.data.kind)), [graph])
  const flowKey = canvasKey({ layers, viewMode, facets, hiddenEdges, generatedAt: data?.generatedAt })

  // React Flow owns node/edge state so it keeps measured dimensions (controlled props without
  // onNodesChange caused re-measure flicker and dropped clicks).
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([])

  useEffect(() => {
    setRfNodes(withRegionEditing(graph.nodes, admin, setRegionGeom))
    setRfEdges(graph.edges)
  }, [graph, admin, setRegionGeom, setRfNodes, setRfEdges])

  // Search reuses the focus (lit/dim) spotlight. Matches keep graph order so the ‹/› stepper
  // walks them predictably.
  const searchList = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    const matches = (node) =>
      node.type === 'card' && `${node.data.title} ${node.data.subtitle || ''}`.toLowerCase().includes(needle)
    return graph.nodes.filter(matches).map((node) => node.id)
  }, [query, graph])
  const searchMatches = useMemo(() => (searchList.length ? new Set(searchList) : null), [searchList])
  const [matchIdx, setMatchIdx] = useState(0)
  useEffect(() => setMatchIdx(0), [query])
  // Clamp when a rebuild shrinks the list, or the counter reads past the end ("5/3").
  useEffect(
    () => setMatchIdx((index) => (searchList.length && index >= searchList.length ? 0 : index)),
    [searchList],
  )

  // Group always offers every cluster. On the graph, status and components come from the build,
  // so a ticked status always narrows a visible set; Table/Matrix draw from the full inventory.
  const facetOptions = useMemo(() => {
    const inventory = data?.inventory || []
    const sortedUnique = (values) => uniqueValues(values).sort()
    const onGraph = view === 'graph'
    return {
      group: clusterDefs.map((cluster) => cluster.label),
      status: onGraph
        ? graph.facetOptions?.status || []
        : sortedUnique(inventory.map((entry) => entry.status)),
      components: onGraph
        ? graph.facetOptions?.components || []
        : sortedUnique(inventory.map((entry) => entry.name)),
    }
  }, [view, graph, data, clusterDefs])
  // Inventory for the Table / Matrix views, filtered by the same facets. An all-selected facet
  // counts as none-selected, the same rule the graph applies.
  const facetInventory = useMemo(() => {
    const inventory = data?.inventory || []
    const groupOptions = clusterDefs.map((cluster) => cluster.label)
    const statusOptions = uniqueValues(inventory.map((entry) => entry.status))
    const hideOptions = uniqueValues(inventory.map((entry) => String(entry.name).toLowerCase()))
    const effectiveFacets = {
      ...facets,
      group: coversAll(facets.group, groupOptions) ? new Set() : facets.group,
      status: coversAll(facets.status, statusOptions) ? new Set() : facets.status,
      hidden: coversAll(facets.hidden, hideOptions) ? new Set() : facets.hidden,
    }
    return inventory.filter((entry) => matchInventory(entry, effectiveFacets, clusterDefs))
  }, [data, facets, clusterDefs])
  // Repo folder -> auto-detected integrations, for the Table's Integrations column. Inventory
  // `repoName` equals the repo `folder`, so this keys cleanly.
  const externalsByRepo = useMemo(() => {
    const byFolder = {}
    for (const repo of data?.repos || []) {
      if (repo.externals?.length) byFolder[repo.folder] = repo.externals
    }
    return byFolder
  }, [data])

  // The arrow toggles apply to the Integrations table too: hiding Kafka drops the graph's Kafka
  // arrows and the table's Kafka rows.
  const integrationEdgeTypes = useMemo(
    () => uniqueValues((data?.integrations || []).map((integration) => PROTOCOL_EDGE[integration.protocol])),
    [data],
  )
  const visibleIntegrations = useMemo(
    () =>
      (data?.integrations || []).filter((integration) => {
        const edgeType = PROTOCOL_EDGE[integration.protocol]
        return !edgeType || !hiddenEdges.has(edgeType)
      }),
    [data, hiddenEdges],
  )

  // The node of the selected single component, so selecting a card spotlights it like a hover.
  // Region selections drive `blockFocus` instead; screen selections have no node.
  const selId = useMemo(() => {
    if (!sel || sel.region || sel.screen) return null
    const sameObject = graph.nodes.find((node) => node.data === sel)
    if (sameObject) return sameObject.id
    const key = sel.repo?.serviceId || sel.repo?.folder || sel.resource?.id
    if (!key) return null
    return findSelNode(graph.nodes, key)?.id ?? null
  }, [sel, graph])

  // What to spotlight, by priority. Facets don't dim: they remove nodes in buildGraph.
  const focusNodes = useMemo(() => {
    if (hoverId) return new Set([hoverId])
    if (searchMatches) return searchMatches
    if (blockFocus) return blockFocus
    if (selId) return new Set([selId])
    return null
  }, [hoverId, searchMatches, blockFocus, selId])

  const lit = useMemo(() => (focusNodes ? litAround(focusNodes, graph.edges) : null), [focusNodes, graph])

  // Only className changes: spreading the existing nodes keeps their measured dims, so no flicker.
  // Unchanged nodes and edges keep their identity so React Flow skips re-rendering them.
  useEffect(() => {
    setRfNodes((nodes) =>
      nodes.map((node) => {
        if (node.type === 'region') return node
        const className = lit ? focusClass(lit.ln, node.id) : undefined
        return node.className === className ? node : { ...node, className }
      }),
    )
    setRfEdges((edges) =>
      edges.map((edge) => {
        const className = lit ? focusClass(lit.le, edge.id) : undefined
        if (edge.className === className) return edge
        // edge labels render in a portal and read data.dim
        return { ...edge, className, data: { ...edge.data, dim: className === 'dim' } }
      }),
    )
  }, [lit, setRfNodes, setRfEdges])

  const defaultGroups = useMemo(() => new Set(defaultOnLabels(clusterDefs)), [clusterDefs])
  const groupParam = useMemo(() => groupParamFor(facets.group, defaultGroups), [facets.group, defaultGroups])
  // The query that mirrors the current view: used by the URL sync, Copy link and saved views.
  const buildViewParams = useCallback(
    () =>
      serializeViewParams({
        layers,
        facets,
        hiddenEdges,
        groupParam,
        dark,
        viewMode,
        view,
        groupBy,
        clientId,
        sel,
        defaults: { dark: cfgDark, mode: cfgMode, view: cfgView },
      }),
    [
      groupParam,
      layers,
      dark,
      view,
      sel,
      facets,
      hiddenEdges,
      clientId,
      viewMode,
      cfgDark,
      cfgMode,
      cfgView,
      groupBy,
    ],
  )
  useEffect(() => {
    const queryString = buildViewParams().toString()
    history.replaceState(null, '', queryString ? '?' + queryString : location.pathname)
  }, [buildViewParams])
  // A saved view's ?sel= may name a node that only exists after its layers/facets rebuild the
  // graph. applyViewParams parks the id here and the next build resolves it. One attempt only,
  // so an id that's truly gone can't hijack a later rebuild.
  const pendingSelRef = useRef(null)
  useEffect(() => {
    if (pendingSelRef.current == null) return
    const id = pendingSelRef.current
    pendingSelRef.current = null
    const node = findSelNode(graph.nodes, id)
    if (node) setSel(node.data)
  }, [graph])
  // The inverse of buildViewParams: restores the whole captured view through the normal setters.
  const applyViewParams = useCallback(
    (queryString) => {
      const saved = parseViewParams(queryString, {
        clusterDefs,
        defaults: { dark: cfgDark, mode: cfgMode, view: cfgView },
      })
      setLayers(saved.layers)
      setFacets(saved.facets)
      setHiddenEdges(saved.hiddenEdges)
      setDark(saved.dark)
      setMode(saved.mode)
      setView(saved.view)
      setGroupBy(saved.groupBy)
      setClientId(saved.clientId)
      if (!saved.selId) {
        setSel(null)
        return
      }
      const node = findSelNode(graph.nodes, saved.selId)
      if (node) setSel(node.data)
      else pendingSelRef.current = saved.selId
    },
    [clusterDefs, graph, cfgDark, cfgMode, cfgView],
  )

  // Restore the URL's selected node once the graph is built.
  const restoredSel = useRef(false)
  useEffect(() => {
    if (restoredSel.current || !graph.nodes.length) return
    const id = initialString('sel', null)
    const node = id ? findSelNode(graph.nodes, id) : null
    if (node) {
      setSel(node.data)
      // embeds open zoomed to the framed node
      if (EMBED) setTimeout(() => frameNodes([node.id]), EMBED_FRAME_DELAY)
    }
    restoredSel.current = true
  }, [graph])

  const health = useMemo(() => pipelineHealth(data, graph), [data, graph])

  const exportPng = useCallback(async () => {
    const viewport = document.querySelector('.react-flow__viewport')
    // Table/Matrix/Integrations have no canvas to capture.
    if (!viewport) return setToast('Export captures the Graph view — switch to Graph first')
    setBusy('Export')
    try {
      // loaded on demand to keep html-to-image out of the main bundle
      const { toPng } = await import('html-to-image')
      const pngUrl = await toPng(viewport, {
        backgroundColor: dark ? EXPORT_BACKGROUND.dark : EXPORT_BACKGROUND.light,
        pixelRatio: 2,
        width: viewport.scrollWidth || undefined,
        height: viewport.scrollHeight || undefined,
      })
      downloadHref(pngUrl, exportFileName(title))
      setToast('Exported PNG')
    } catch (error) {
      setToast('Export failed — ' + errorText(error, 120))
    } finally {
      setBusy(null)
    }
  }, [dark, title])

  // The exact data object the app runs on, e.g. to hand to Claude or inspect.
  const downloadData = useCallback(() => {
    if (!data) return
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const blobUrl = URL.createObjectURL(blob)
    downloadHref(blobUrl, 'repo-atlas-data.json')
    URL.revokeObjectURL(blobUrl)
    setToast('Downloaded data (JSON)')
  }, [data])

  // The URL already mirrors the view, so the link is just location.href.
  const copyLink = useCallback(() => {
    const url = location.href
    const done = () => setToast('Link copied to clipboard')
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => setToast(url))
    else setToast(url)
  }, [])

  const post = async (endpoint, label) => {
    setBusy(label)
    setToast(null)
    try {
      const response = await fetch(endpoint, { method: 'POST' })
      const body = await response.json()
      if (!response.ok || body.ok === false) throw new Error(JSON.stringify(body.log || body.error || body))
      if (endpoint === '/api/regenerate') {
        await load()
        setToast('Regenerated — data refreshed')
      } else {
        setToast('Published to ' + body.path)
      }
    } catch (error) {
      setToast(label + ' failed (is the dev server running?) — ' + errorText(error, 200))
    } finally {
      setBusy(null)
    }
  }

  const onNodeClick = useCallback(
    (_, node) => {
      if (node.type !== 'region') {
        setSel(node.data)
        setBlockFocus(null)
        return
      }
      const ids = node.data.members || []
      const memberIds = new Set(ids)
      const members = graph.nodes
        .filter((n) => n.type === 'card' && memberIds.has(n.id))
        .map((n) => ({ id: n.id, title: singleLineTitle(n.data.title), kind: n.data.kind }))
      setBlockFocus(new Set(ids))
      setSel({
        region: {
          label: node.data.label,
          color: node.data.color,
          members,
          note: config.regionNotes?.[node.data.label] || '',
        },
      })
    },
    [graph, config],
  )
  // Double-clicking a client card drills into its screens; a single click still selects.
  const onNodeDoubleClick = useCallback(
    (_, node) => {
      const folder = node.data?.repo?.folder
      const isClientCard = node.type === 'card' && node.data?.kind === 'client'
      if (isClientCard && clientScreenCount(data, folder)) setClientId(folder)
    },
    [data],
  )
  const onSelectScreen = useCallback((screen, clientTitle) => {
    if (screen) setSel({ screen, clientTitle })
  }, [])
  const frameNodes = useCallback((ids) => {
    if (!ids?.length) return
    rfRef.current?.fitView({
      nodes: ids.map((id) => ({ id })),
      duration: FRAME_DURATION,
      padding: 0.5,
      maxZoom: 1.3,
    })
  }, [])
  // Cross-navigation from the Details panel. `key` may be a node id, a repo folder or serviceId
  // (adoption chips are keyed by folder), a repo name, or an internal package name. No-op when
  // that node isn't on the map.
  const navigateTo = useCallback(
    (key) => {
      if (!key) return
      const nodes = graph.nodes
      const uiHubNode = () =>
        uiPackagesOf(config).has(key) && nodes.find((node) => uiHubFoldersOf(config).includes(node.id))
      const target =
        nodes.find((node) => node.id === key) ||
        findSelNode(nodes, key) ||
        nodes.find((node) => node.data?.repo?.name === key) ||
        uiHubNode() ||
        nodes.find((node) => node.id === 'pkg:' + key)
      if (!target || target.type === 'region') return
      setSel(target.data)
      setBlockFocus(null)
      frameNodes([target.id])
    },
    [graph, config, frameNodes],
  )
  const stepMatch = useCallback(
    (direction) => {
      if (!searchList.length) return
      const next = (matchIdx + direction + searchList.length) % searchList.length
      setMatchIdx(next)
      const node = graph.nodes.find((n) => n.id === searchList[next])
      if (node) setSel(node.data)
      frameNodes([searchList[next]])
    },
    [searchList, matchIdx, graph, frameNodes],
  )
  const onNodeEnter = useCallback((_, node) => {
    if (node.type !== 'region') setHoverId(node.id)
  }, [])
  const onNodeLeave = useCallback(() => setHoverId(null), [])
  // Admin only: remember where a card was dropped so it survives rebuilds and can be published.
  const onNodeDragStop = useCallback(
    (_, node) => {
      setHelper(NO_HELPER)
      if (node.type === 'region') {
        // only the position moved; keep the box's current size
        const current = (layout[viewMode] || {})[node.id] || {}
        const w = current.w ?? Math.round(node.measured?.width ?? node.width ?? 0)
        const h = current.h ?? Math.round(node.measured?.height ?? node.height ?? 0)
        setRegionGeom(node.id, { ...roundedPosition(node), w, h })
        return
      }
      pushUndo()
      setLayout((current) => withOverride(current, viewMode, node.id, roundedPosition(node)))
    },
    [pushUndo, viewMode, setRegionGeom, layout],
  )
  const resetLayout = useCallback(() => {
    pushUndo()
    setLayout(EMPTY_LAYOUT)
  }, [pushUndo])
  // Re-flow this view to the computed layout by clearing the current mode's overrides.
  const autoArrange = useCallback(() => {
    pushUndo()
    setLayout((current) => ({ ...current, [viewMode]: {} }))
  }, [pushUndo, viewMode])
  const undoLayout = useCallback(() => {
    const previous = layoutUndo.current.pop()
    if (previous) setLayout(previous)
  }, [])
  // Cmd/Ctrl+Z undoes the last admin drag or re-flow, except while typing in a field.
  useEffect(() => {
    if (!admin) return
    const onKeyDown = (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')
      const isUndo = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z'
      if (!isUndo || typing) return
      event.preventDefault()
      undoLayout()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [admin, undoLayout])
  // Admin drag: snap the card to align with its neighbours (Figma-style guides) on top of the grid
  // snap, and show the guide lines.
  const onNodesChangeAdmin = useCallback(
    (changes) => {
      const change = changes[0]
      const isSingleDrag =
        admin && changes.length === 1 && change.type === 'position' && change.dragging && change.position
      if (isSingleDrag) {
        const { horizontal, vertical, color, snapPosition } = getHelperLines(change, rfNodes)
        if (snapPosition.x != null) change.position.x = snapPosition.x
        if (snapPosition.y != null) change.position.y = snapPosition.y
        setHelper({ h: horizontal, v: vertical, color })
      } else if (helper.h !== undefined || helper.v !== undefined) {
        setHelper(NO_HELPER)
      }
      onNodesChange(changes)
    },
    [admin, rfNodes, onNodesChange, helper.h, helper.v],
  )
  const onPaneClick = useCallback(() => {
    setBlockFocus(null)
    setSel(null)
  }, [])
  // Clicking an edge spotlights its two endpoints.
  const onEdgeClick = useCallback((_, edge) => {
    setBlockFocus(new Set([edge.source, edge.target]))
    setSel(null)
  }, [])
  // Admin only. The menu items are built at render time so they reflect the current target.
  const onNodeContextMenu = useCallback(
    (event, node) => {
      if (!admin) return
      event.preventDefault()
      setCtx({ x: event.clientX, y: event.clientY, node })
    },
    [admin],
  )
  const onPaneContextMenu = useCallback(
    (event) => {
      if (!admin) return
      event.preventDefault()
      setCtx({ x: event.clientX, y: event.clientY, node: null })
    },
    [admin],
  )
  const fitView = useCallback(() => rfRef.current?.fitView({ duration: FRAME_DURATION, padding: 0.15 }), [])
  const extras = data?.extras

  const { filterCount, isDefaultFilters } = filterSummary({ view, facets, layers, hiddenEdges, groupParam })
  const resetFilters = useCallback(() => {
    setFacets({ group: new Set(defaultGroups), status: new Set(), health: new Set(), hidden: new Set() })
    setLayers(Object.fromEntries(LAYERS.map((layer) => [layer.key, layer.default])))
    setHiddenEdges(new Set())
  }, [defaultGroups])

  const layoutDirty = admin && JSON.stringify(layout) !== JSON.stringify(savedLayout)
  const modeLayoutCount = Object.keys(layout[viewMode] || {}).length

  if (!data && denied) return <AccessDenied dark={dark} reason={denied} />
  if (!data && enc) {
    return (
      <div className={'app' + (dark ? ' dark' : '')}>
        <Gate onUnlock={unlock} error={gateError} busy={gateBusy} />
      </div>
    )
  }

  const openAdmin = () => setShowAdmin(true)
  const openEmbed = () => setShowEmbed(true)
  const showPipelineActions = import.meta.env.DEV && admin
  // Golden Path needs a backend for its data, so the static Pages build hides the link.
  const showGoldenPath = import.meta.env.DEV || import.meta.env.VITE_DATA_URL
  const pickView = (nextView) => {
    setView(nextView)
    setClientId(null) // switching the view exits any per-client drill-down
  }
  const buildCtxItems = () =>
    contextMenuItems(ctx, {
      modeLayout: layout[viewMode] || {},
      config,
      data,
      onNodeClick,
      resizeRegionToFit,
      clearRegionGeom,
      openAdmin,
      frameNodes,
      setClientId,
      fitView,
      autoArrange,
      resetLayout,
    })
  const clientTitle = () => {
    const repo = data.repos?.find((r) => r.folder === clientId)
    return repo?.inventory?.name || repo?.displayName || clientId
  }
  const leaveClientView = () => {
    setClientId(null)
    if (sel?.screen) setSel(null)
  }

  return (
    <div className={'app' + (dark ? ' dark' : '') + (EMBED ? ' embed' : '')}>
      <header className={'toolbar' + (EMBED ? ' embed' : '')}>
        <Brand
          logoUrl={logoUrl}
          title={title}
          subtitle={subtitle}
          generatedAt={data?.generatedAt}
          dataStaleDays={dataStaleDays}
        />
        {EMBED ? (
          <EmbedToolbarActions dark={dark} setDark={setDark} />
        ) : (
          <>
            <ViewMenu view={view} onPick={pickView} />
            {admin ? <DetailSwitch mode={mode} setMode={setMode} /> : null}
            {view === 'graph' ? <GroupByMenu groupBy={groupBy} setGroupBy={setGroupBy} /> : null}
            <FiltersMenu
              view={view}
              facets={facets}
              facetOptions={facetOptions}
              toggleFacet={toggleFacet}
              filterCount={filterCount}
              isDefaultFilters={isDefaultFilters}
              resetFilters={resetFilters}
              clusterDefs={clusterDefs}
              layers={layers}
              toggleLayer={toggleLayer}
              graphEdgeTypes={graph.edgeTypesPresent}
              integrationEdgeTypes={integrationEdgeTypes}
              config={config}
              hiddenEdges={hiddenEdges}
              toggleEdge={toggleEdge}
              setComponentsHidden={setComponentsHidden}
              compFilter={compFilter}
              setCompFilter={setCompFilter}
            />
            <SearchBox
              view={view}
              query={query}
              setQuery={setQuery}
              searchList={searchList}
              matchIdx={matchIdx}
              stepMatch={stepMatch}
              frameNodes={frameNodes}
            />
            <div className="spacer" />
            {health.count ? (
              <HealthButton
                health={health}
                org={data.org}
                open={showHealth}
                setOpen={setShowHealth}
                wrapRef={healthRef}
              />
            ) : null}
            <span className="tb-sep" />
            <ViewsMenu
              views={views}
              persistViews={persistViews}
              buildViewParams={buildViewParams}
              copyLink={copyLink}
              applyViewParams={applyViewParams}
              setToast={setToast}
            />
            <button
              className="btn ghost"
              onClick={copyLink}
              title="Copy a shareable link to this exact view"
              aria-label="Copy shareable link"
            >
              <Icon name="link" />
            </button>
            <button
              className="btn ghost"
              onClick={openEmbed}
              title="Embed this view as an iframe (frames the current filtered slice)"
              aria-label="Embed this view"
            >
              <Icon name="code" />
            </button>
            {/* The one link into the Golden Path screen (src/golden-path/, routed in main.jsx). A
                plain href, so it lands there with no map state in the URL. */}
            {showGoldenPath && (
              <a
                className="btn ghost"
                href="?view=golden-path"
                title="Golden Path compliance"
                aria-label="Golden Path compliance"
              >
                <Icon name="compliance" />
              </a>
            )}
            <button
              className="btn ghost"
              onClick={() => setShowLegend(true)}
              title="Legend / help"
              aria-label="Legend and help"
            >
              <Icon name="help" />
            </button>
            <button
              className="btn ghost"
              disabled={!data}
              onClick={downloadData}
              title="Download the underlying data (JSON)"
              aria-label="Download data as JSON"
            >
              <Icon name="download" />
            </button>
            {admin ? (
              <button
                className="btn ghost"
                onClick={openAdmin}
                title="Settings & curate the model (Admin)"
                aria-label="Settings — admin"
              >
                <Icon name="gear" />
              </button>
            ) : null}
            <ThemeToggle dark={dark} setDark={setDark} />
            <span className="tb-sep" />
            <UserChip />
            <ToolbarActions
              busy={busy}
              exportPng={exportPng}
              showPipelineActions={showPipelineActions}
              post={post}
            />
            <MoreMenu
              busy={busy}
              exportPng={exportPng}
              downloadData={downloadData}
              openEmbed={openEmbed}
              showPipelineActions={showPipelineActions}
              post={post}
            />
          </>
        )}
      </header>

      {showLegend ? <LegendOverlay onClose={() => setShowLegend(false)} /> : null}
      {showEmbed ? (
        <EmbedDialog
          title={title}
          onClose={() => setShowEmbed(false)}
          onCopied={() => setToast('Embed code copied to clipboard')}
        />
      ) : null}
      {ctx && admin ? (
        <ContextMenu x={ctx.x} y={ctx.y} items={buildCtxItems()} onClose={() => setCtx(null)} />
      ) : null}
      {showAdmin && data && admin ? (
        <Suspense fallback={null}>
          <AdminPanel
            data={data}
            layout={layout}
            onResetLayout={resetLayout}
            onSaved={() => setSavedLayout(layout)}
            onClose={() => setShowAdmin(false)}
          />
        </Suspense>
      ) : null}

      <div className="body">
        {!data ? (
          <Spinner label="Loading architecture…" />
        ) : clientId ? (
          <Suspense fallback={<Spinner />}>
            <ClientDetailView
              data={data}
              folder={clientId}
              title={clientTitle()}
              dark={dark}
              onBack={leaveClientView}
              onSelectScreen={onSelectScreen}
            />
          </Suspense>
        ) : TABLE_VIEWS.includes(view) ? (
          <TableViews
            view={view}
            facetInventory={facetInventory}
            visibleIntegrations={visibleIntegrations}
            data={data}
            query={query}
            config={config}
            externalsByRepo={externalsByRepo}
            setSel={setSel}
          />
        ) : (
          <div className="canvas" key={flowKey}>
            <ReactFlow
              onInit={(instance) => (rfRef.current = instance)}
              nodes={rfNodes}
              edges={rfEdges}
              onNodesChange={onNodesChangeAdmin}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onEdgeClick={onEdgeClick}
              onNodeMouseEnter={onNodeEnter}
              onNodeMouseLeave={onNodeLeave}
              onNodeDragStop={onNodeDragStop}
              onPaneClick={onPaneClick}
              onNodeContextMenu={onNodeContextMenu}
              onPaneContextMenu={onPaneContextMenu}
              nodesDraggable
              snapToGrid={admin}
              snapGrid={[GRID, GRID]}
              fitView
              fitViewOptions={{ padding: 0.15 }}
              minZoom={0.1}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={18} color={dark ? '#223052' : '#e6e8ee'} />
              {admin ? (
                <Background id="grid" variant="lines" gap={GRID} color={dark ? '#18233c' : '#eceef3'} />
              ) : null}
              {admin ? <HelperLines horizontal={helper.h} vertical={helper.v} color={helper.color} /> : null}
              {EMBED ? null : (
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(node) => KIND[node.data?.kind]?.color || MINIMAP_FALLBACK_COLOR}
                />
              )}
              <Controls />
            </ReactFlow>
            {admin && (layoutDirty || modeLayoutCount > 0) ? (
              <LayoutPill layoutDirty={layoutDirty} autoArrange={autoArrange} openAdmin={openAdmin} />
            ) : null}
            {EMBED ? null : (
              <Legend
                kinds={kindsPresent}
                edgeTypesPresent={graph.edgeTypesPresent}
                hiddenEdges={hiddenEdges}
                config={config}
              />
            )}
          </div>
        )}

        {sel ? (
          <Details
            data={sel}
            extras={extras}
            mode={viewMode}
            width={panelW}
            onResize={setPanelW}
            onClose={() => setSel(null)}
            onNavigate={navigateTo}
            onDrillIn={setClientId}
            config={config}
            frameworkConsumers={data?.frameworkConsumers}
          />
        ) : null}
      </div>

      {busy || toast ? (
        <div className={'toast' + (toast && /fail/i.test(toast) ? ' err' : '')}>
          {busy ? busy + ' in progress… (the pipeline can take a minute)' : toast}
        </div>
      ) : null}
    </div>
  )
}
