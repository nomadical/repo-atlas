import React, { useEffect, useMemo, useRef, useState, useCallback, lazy, Suspense } from 'react'
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import CardNode from './CardNode.jsx'
import RegionNode from './RegionNode.jsx'
import { buildGraph, KIND, LAYERS, edgeTypesFor, resolveClusters, DEFAULT_CLUSTERS, matchInventory, uiPackagesOf, uiHubFoldersOf, coversAll } from './graph.js'
import { edgeTypes } from './floating.jsx'
import { getUser, logout, authEnabled, relogin, isAdmin } from './auth.js'
import { getData, decryptData } from './data.js'
import { Dropdown, FilterRow, docHref } from './ui.jsx'
import Gate from './Gate.jsx'
import { Legend, LegendOverlay } from './Legend.jsx'
import Details from './Details.jsx'
import { getHelperLines, HelperLines } from './HelperLines.jsx'
import { Icon } from './icons.jsx'
import ContextMenu from './ContextMenu.jsx'

// Off-the-default-path UI is code-split so it stays out of the initial bundle: the Table/Matrix
// views load when the user switches to them; the Admin panel only for admins who open it.
const InventoryTable = lazy(() => import('./InventoryViews.jsx').then((m) => ({ default: m.InventoryTable })))
const MatrixView = lazy(() => import('./InventoryViews.jsx').then((m) => ({ default: m.MatrixView })))
const IntegrationsTable = lazy(() => import('./InventoryViews.jsx').then((m) => ({ default: m.IntegrationsTable })))
const AdminPanel = lazy(() => import('./AdminPanel.jsx'))
const ClientDetailView = lazy(() => import('./ClientDetailView.jsx'))

const nodeTypes = { card: CardNode, region: RegionNode }
// Integration protocol -> arrow-type key (see graph.js EDGE_TYPES), so the Arrows / integrations
// filter toggles line up with the Integrations table's Protocol column.
const PROTOCOL_EDGE = { REST: 'rest', Kafka: 'kafka' }
const GRID = 16 // snap-to-grid step (admin drag mode)
const NO_HELPER = { h: undefined, v: undefined, color: undefined }
// Card-position overrides are scoped per view-mode (dev vs overview have different node sets, so a
// card arranged in one shouldn't displace the other). Normalize legacy flat {id:{x,y}} configs.
const EMPTY_LAYOUT = { dev: {}, overview: {} }
const normalizeLayout = (l) => {
  if (!l || typeof l !== 'object') return { ...EMPTY_LAYOUT }
  if (l.dev || l.overview) return { dev: l.dev || {}, overview: l.overview || {} }
  return { dev: l, overview: {} } // legacy flat map → treat as the dev layout
}

// --- shareable view state encoded in the URL query (G) ---
// Layer params come from the LAYERS registry (graph.js); each serializes as its DEVIATION from
// the default — absent at the default, `=1`/`=0` otherwise — so a default-on layer switched OFF
// survives a reload/share, and untouched views keep a clean URL. Legacy `be=1&dpl=1` links parse
// identically.
const initialParams = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
const qFlag = (param, dflt) => (initialParams.has(param) ? initialParams.get(param) === '1' : dflt)
const qStr = (k, dflt) => initialParams.get(k) ?? dflt
// A comma-list facet param: the values when the key is present (an empty `?k=` → [] = "show all",
// which is how a cleared group survives a reload / embed), or null when the key is absent entirely.
const qList = (k) => (initialParams.has(k) ? (initialParams.get(k) || '').split(',').filter(Boolean) : null)
// Groups shown before any toggle. Seeded from the built-in clusters' `defaultOn` flags (re-seeded from
// the config's clusters once data loads), so ISS/IoT stay hidden by default while CSS/Shared show.
const defaultOnLabels = (clusterDefs) => clusterDefs.filter((c) => c.defaultOn).map((c) => c.label)
// Embed (kiosk) mode: the page was loaded inside an <iframe> via ?embed=1. We strip the toolbar
// chrome to just a title + "open full map" link so a specific, pre-filtered slice of the map can be
// framed in a wiki page. The filters/facets/view in the URL already define *which* slice.
const EMBED = initialParams.get('embed') === '1'

const VIEW_LABELS = { graph: 'Graph', matrix: 'Matrix', table: 'Table', integrations: 'Integrations' }
// single view whitelist — keep the URL codec, applyViewParams and the Admin default-view select in lockstep
const VIEWS = Object.keys(VIEW_LABELS)
// graph lane groupings (Group by dropdown + `by` URL param)
const GROUP_BY_LABELS = { team: 'By team', application: 'By application', platform: 'By platform' }
const DEFAULT_TITLE = 'Architecture Map'

// Resolve a saved ?sel= id to a card node, aliasing the repo FOLDER (old links / saved views used the
// folder before the serviceId became the node id) and the serviceId, so both keep resolving.
const matchSelNode = (n, id) => n.type === 'card' && (n.id === id || n.data.repo?.folder === id || n.data.repo?.serviceId === id)

// A pipeline-health token. Most are repo names (optionally followed by " — reason" or
// " (detail)"); link the repo part straight to GitHub so an owner can jump in and curate it.
// Tokens that aren't a single repo-like word (free-text drift notes) render as plain chips.
function HealthChip({ token, org }) {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*?)(\s+(?:—|\().*)?$/.exec(token)
  const name = m?.[1]
  // Without a known org (data.org) we can't build a repo link — fall back to a plain chip.
  if (!name || /\s/.test(name) || !org) return <span className="mod-chip">{token}</span>
  return (
    <span className="mod-chip">
      <a href={`https://github.com/${org}/${name}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
        {name}
      </a>
      {m[2] || ''}
    </span>
  )
}

// Embed dialog — turns the *current* filtered view into a copy-pasteable <iframe> snippet plus a
// live preview, so a curator can frame exactly the slice they're looking at into a wiki page. The
// URL already mirrors every filter/facet/view/selection, so we just take location.search, force
// embed=1, and hand back the snippet. Dismiss via the ✕, the backdrop, or Esc.
function EmbedDialog({ onClose, onCopied, title }) {
  const [w, setW] = useState('100%')
  const [h, setH] = useState('640')
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const src = useMemo(() => {
    const p = new URLSearchParams(location.search)
    p.set('embed', '1')
    return location.origin + location.pathname + '?' + p.toString()
  }, [])
  // numeric dimensions get a px unit; "100%" and other CSS values pass through untouched
  const dim = (v) => (/^\d+$/.test(String(v).trim()) ? v + 'px' : String(v).trim() || 'auto')
  const snippet = `<iframe src="${src}" title="${title}" width="${dim(w)}" height="${dim(h)}" loading="lazy" style="border:0;border-radius:12px;max-width:100%"></iframe>`
  const copy = () => {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(snippet).then(() => onCopied?.())
    else onCopied?.()
  }
  return (
    <div className="legend-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Embed this view">
      <div className="legend-card embed-card" onClick={(e) => e.stopPropagation()}>
        <div className="legend-head">
          <h3>Embed this view</h3>
          <button className="btn ghost" onClick={onClose} aria-label="Close embed dialog">
            <Icon name="close" />
          </button>
        </div>
        <p className="embed-hint">
          The embed shows <b>exactly the current filters, view &amp; selection</b>. Adjust the filters first to frame a specific part of the map, then copy the
          snippet below into your wiki's HTML/iframe macro or any web page.
        </p>
        <div className="embed-dims">
          <label>
            Width
            <input value={w} onChange={(e) => setW(e.target.value)} placeholder="100%" />
          </label>
          <label>
            Height
            <input value={h} onChange={(e) => setH(e.target.value)} placeholder="640" />
          </label>
          <span className="embed-dims-note">Plain numbers are pixels; use 100% to fill the container.</span>
        </div>
        <textarea className="embed-code" readOnly value={snippet} rows={3} onFocus={(e) => e.target.select()} />
        <div className="embed-actions">
          <a className="btn ghost" href={src} target="_blank" rel="noreferrer" title="Open the embeddable view in a new tab">
            <Icon name="external" /> Preview
          </a>
          <button className="btn primary" onClick={copy}>
            <Icon name="code" /> Copy embed code
          </button>
        </div>
        <div className="embed-preview-wrap">
          <div className="embed-preview-cap">Live preview</div>
          <iframe className="embed-preview" src={src} title="Embed preview" loading="lazy" />
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [data, setData] = useState(null)
  // Detail layers — additive; one state object driven by the LAYERS registry, seeded from the URL.
  const [layers, setLayers] = useState(() => Object.fromEntries(LAYERS.map((l) => [l.key, qFlag(l.param, l.default)])))
  const toggleLayer = useCallback((key, on) => setLayers((ls) => ({ ...ls, [key]: on })), [])
  // Default to the (touch-friendly) Table on small screens unless the URL pins a view. Skip the
  // heuristic in embed mode: a narrow iframe would otherwise flip a framed graph to the table.
  const [view, setView] = useState(() => {
    const smallScreen = typeof window !== 'undefined' && window.innerWidth < 760
    const dflt = !initialParams.has('view') && smallScreen && !EMBED ? 'table' : 'graph'
    const v = qStr('view', dflt)
    return VIEWS.includes(v) ? v : 'graph'
  })
  const [sel, setSel] = useState(null)
  // Graph lane grouping (Group by: Team | Application | Platform). Layout-only — the team clusters
  // stay the Group FILTER taxonomy, so grouping and filtering compose. URL param `by`.
  const [groupBy, setGroupBy] = useState(() => {
    const v = qStr('by', 'team')
    return v === 'application' || v === 'platform' ? v : 'team'
  })
  // Per-client drill-down: when set, the body shows ClientDetailView (screens + endpoint usage) for
  // this repo folder, overlaying whatever view is selected. Cleared by the in-view Back button.
  const [clientId, setClientId] = useState(() => qStr('client', '') || null)
  const [busy, setBusy] = useState(null)
  const [toast, setToast] = useState(null)
  const [query, setQuery] = useState('') // search box (F)
  const [compFilter, setCompFilter] = useState('') // text filter inside the Filters → Components list
  // Narrowing filters — faceted: OR within a dimension, AND across. `group` = team cluster,
  // `status` = lifecycle stage, `health` = at-risk (alerts / failing CI). An empty Set means that
  // dimension imposes no constraint. Seeded from the URL for shareable links; absent from the URL,
  // `group` falls back to the default-on clusters (so ISS/IoT start hidden) while `status`/`health`
  // start empty (no constraint).
  const [facets, setFacets] = useState(() => ({
    group: new Set(qList('group') ?? defaultOnLabels(DEFAULT_CLUSTERS)),
    status: new Set(qList('status') ?? []),
    health: new Set(qFlag('risk', false) ? ['at-risk'] : []),
    // per-component show/hide list, keyed by lowercased inventory name (seeded from ?hide=)
    hidden: new Set((qList('hide') ?? []).map((s) => s.toLowerCase())),
  }))
  const toggleFacet = useCallback(
    (dim, val) =>
      setFacets((f) => {
        const next = new Set(f[dim])
        if (next.has(val)) next.delete(val)
        else next.add(val)
        return { ...f, [dim]: next }
      }),
    [],
  )
  // Bulk show/hide for the per-component list (the Select all / Clear buttons). `names` is whatever
  // is currently visible in the list (so it composes with the text filter); keyed by lowercased name.
  const setComponentsHidden = useCallback((names, hide) => {
    const keys = names.map((n) => n.toLowerCase())
    setFacets((f) => {
      const next = new Set(f.hidden)
      for (const k of keys) {
        if (hide) next.add(k)
        else next.delete(k)
      }
      return { ...f, hidden: next }
    })
  }, [])
  // Arrow-type visibility — a Set of edge-type keys the user has HIDDEN (empty = show every arrow).
  // Seeded from the URL for shareable/embedded links; toggled from the on-canvas Legend arrow rows.
  const [hiddenEdges, setHiddenEdges] = useState(() => new Set(qList('hedge') ?? []))
  const toggleEdge = useCallback(
    (key) =>
      setHiddenEdges((s) => {
        const next = new Set(s)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      }),
    [],
  )
  const [showHealth, setShowHealth] = useState(false) // health popover (E)
  // Dismiss the health popover on an outside click / Escape (it isn't a Dropdown, so it needs its own).
  const healthRef = useRef(null)
  useEffect(() => {
    if (!showHealth) return
    const onDoc = (e) => {
      if (healthRef.current && !healthRef.current.contains(e.target)) setShowHealth(false)
    }
    const onKey = (e) => e.key === 'Escape' && setShowHealth(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [showHealth])
  const [showLegend, setShowLegend] = useState(false) // legend / help overlay
  const [showEmbed, setShowEmbed] = useState(false) // embed-snippet builder dialog
  const [showAdmin, setShowAdmin] = useState(false) // admin / curation editor
  const [layout, setLayout] = useState(EMPTY_LAYOUT) // admin drag overrides per mode; seeded from config
  const [savedLayout, setSavedLayout] = useState(EMPTY_LAYOUT) // last persisted layout, for dirty tracking
  const [helper, setHelper] = useState(NO_HELPER) // active alignment guide lines while dragging
  const [ctx, setCtx] = useState(null) // right-click context menu: { x, y, node } (node null = pane)
  const rfRef = useRef(null) // ReactFlow instance — for fitView/navigation
  const layoutUndo = useRef([]) // stack of prior layout snapshots (Cmd/Ctrl+Z)
  // snapshot the current layout so the last few drags / re-flows / region edits can be undone
  const pushUndo = useCallback(() => {
    layoutUndo.current.push(layout)
    if (layoutUndo.current.length > 50) layoutUndo.current.shift()
  }, [layout])
  const [panelW, setPanelW] = useState(() => {
    const saved = Number(typeof localStorage !== 'undefined' && localStorage.getItem('panelW'))
    return saved >= 280 ? saved : 360
  })
  // Per-user named views: each saved view is the query string buildViewParams() emits, stored under
  // localStorage (not shared across users — the URL / Copy-link covers sharing). Persisted eagerly on
  // every mutation, mirroring the panelW localStorage pattern. Dragged card positions are NOT saved.
  const [views, setViews] = useState(() => {
    try {
      const arr = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem('archmap-views')) || '[]')
      return Array.isArray(arr) ? arr : []
    } catch {
      return []
    }
  })
  const persistViews = useCallback((next) => {
    setViews(next)
    try {
      localStorage.setItem('archmap-views', JSON.stringify(next))
    } catch {}
  }, [])

  const [enc, setEnc] = useState(null) // encrypted envelope awaiting a passphrase
  const [gateError, setGateError] = useState(false)
  const [gateBusy, setGateBusy] = useState(false)
  const [denied, setDenied] = useState(null) // 403 from the data API — signed in but missing the read role
  const load = useCallback(() => {
    getData()
      .then(async (res) => {
        if (res.data) return setData(res.data)
        setEnc(res.encrypted)
        const saved = localStorage.getItem('archmap-pass') // unlock silently on revisits
        if (saved)
          try {
            setData(await decryptData(res.encrypted, saved))
          } catch {
            localStorage.removeItem('archmap-pass')
          }
      })
      .catch((e) => {
        // Session expired -> the token refresh failed and the data endpoint 401'd; re-authenticate.
        if (e?.unauthorized && authEnabled()) {
          setToast('Session expired — signing in again…')
          relogin()
          return
        }
        // Signed in but missing the read role (e.g. SAM_READ) — a clear ask-for-access screen.
        if (e?.forbidden) {
          setDenied(String(e.message || 'access denied'))
          return
        }
        setToast('Failed to load data: ' + e)
      })
  }, [])
  useEffect(() => {
    load()
  }, [load])
  // Escape clears the current spotlight/selection/search from anywhere (unless a menu/overlay owns it)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (showLegend || showAdmin) return // those handle their own Escape
      // an open embed dialog / context menu owns this Escape: dismiss it WITHOUT also clearing
      // the selection and search underneath
      if (showEmbed) return setShowEmbed(false)
      if (ctx) return setCtx(null)
      setSel(null)
      setBlockFocus(null)
      setQuery('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showLegend, showAdmin, showEmbed, ctx])
  const unlock = useCallback(
    async (pass) => {
      setGateBusy(true)
      setGateError(false)
      try {
        setData(await decryptData(enc, pass))
        try {
          localStorage.setItem('archmap-pass', pass)
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
  const [dark, setDark] = useState(() => qFlag('dark', false))
  const [mode, setMode] = useState(() => (qStr('mode', 'dev') === 'overview' ? 'overview' : 'dev')) // 'dev' | 'overview'
  // Privileged controls (settings, dev mode, regenerate/publish) are admin-only; non-admins are
  // locked to the read-only overview regardless of the mode state / URL.
  const admin = isAdmin()
  const viewMode = admin ? mode : 'overview'
  // persist a region's geometry override (move/resize) into the current mode's layout map
  const setRegionGeom = useCallback(
    (id, g) => {
      pushUndo()
      setLayout((l) => ({ ...l, [viewMode]: { ...l[viewMode], [id]: g } }))
    },
    [pushUndo, viewMode],
  )
  // drop a region's geometry override so it reverts to the auto-computed bounds on the next build
  const clearRegionGeom = useCallback(
    (id) => {
      pushUndo()
      setLayout((l) => {
        const mode = { ...l[viewMode] }
        delete mode[id]
        return { ...l, [viewMode]: mode }
      })
    },
    [pushUndo, viewMode],
  )
  // shrink/grow a region box so it tightly wraps its member cards (their live positions + measured
  // sizes), using the same padding the auto-layout uses (see graph.js `box`): 34px sides, extra top
  // room for the label. No-op if the region has no members currently on the canvas.
  const resizeRegionToFit = useCallback(
    (regionId, members) => {
      const nodes = rfRef.current?.getNodes?.() || []
      const idset = new Set(members || [])
      const cards = nodes.filter((n) => idset.has(n.id))
      if (!cards.length) return
      const dim = (n, k) => (k === 'w' ? (n.measured?.width ?? n.width ?? 224) : (n.measured?.height ?? n.height ?? 96))
      const xs = cards.map((n) => n.position.x)
      const ys = cards.map((n) => n.position.y)
      const minX = Math.min(...xs) - 34
      const maxX = Math.max(...cards.map((n) => n.position.x + dim(n, 'w'))) + 34
      const minY = Math.min(...ys) - 52
      const maxY = Math.max(...cards.map((n) => n.position.y + dim(n, 'h'))) + 30
      setRegionGeom(regionId, { x: Math.round(minX), y: Math.round(minY), w: Math.round(maxX - minX), h: Math.round(maxY - minY) })
    },
    [setRegionGeom],
  )

  // editable, published app config (config.json -> data.config). All optional; each falls back to
  // the built-in default so an un-curated config changes nothing.
  const config = data?.config || {}
  const clusterDefs = useMemo(() => resolveClusters(config), [config])
  const title = config.title || DEFAULT_TITLE
  const subtitle = config.subtitle || ''
  const logoUrl = config.logoUrl || ''
  // Freshness threshold for the toolbar's "data N days ago" badge — how old the GENERATED DATA may
  // get before the badge turns amber. Distinct from `staleDays` (repo commit staleness, graph.js).
  const dataStaleDays = Number(config.dataStaleDays) > 0 ? Number(config.dataStaleDays) : 7
  // Config-aware URL defaults: dark/mode/view serialize as their DEVIATION from these (mirroring
  // the layer params), so in a deployment whose config flips a default the built-in value stays
  // representable — switching back to it writes an explicit param (`dark=0`, `view=graph`) instead
  // of an empty URL that the config-defaults effect silently reverts on the next reload.
  const cfgDark = config.defaultTheme === 'dark'
  const cfgMode = config.defaultMode === 'overview' ? 'overview' : 'dev'
  const cfgView = VIEW_LABELS[config.defaultView] ? config.defaultView : 'graph'
  useEffect(() => {
    document.title = title
  }, [title])

  // Apply config-driven defaults (view / mode / theme) once, after the data (and thus config)
  // first loads — but only for state the URL didn't already pin, so shared links always win and a
  // user's in-session change is never clobbered. Small screens keep the touch-friendly Table.
  const appliedDefaults = useRef(false)
  useEffect(() => {
    if (appliedDefaults.current || !data?.config) return
    appliedDefaults.current = true
    const c = data.config
    const smallScreen = typeof window !== 'undefined' && window.innerWidth < 760
    if (!initialParams.has('view') && !smallScreen && VIEW_LABELS[c.defaultView]) setView(c.defaultView)
    if (!initialParams.has('mode') && (c.defaultMode === 'overview' || c.defaultMode === 'dev')) setMode(c.defaultMode)
    if (!initialParams.has('dark') && (c.defaultTheme === 'dark' || c.defaultTheme === 'light')) setDark(c.defaultTheme === 'dark')
    // when the config defines its own clusters, seed the default-on groups from them (unless the URL
    // already pinned ?group=), so a fork controls which groups start hidden.
    if (!initialParams.has('group') && Array.isArray(c.clusters) && c.clusters.length) setFacets((f) => ({ ...f, group: new Set(defaultOnLabels(c.clusters)) }))
    if (c.layout && typeof c.layout === 'object') {
      const norm = normalizeLayout(c.layout) // admin-curated card positions (per mode)
      setLayout(norm)
      setSavedLayout(norm)
    }
  }, [data])

  // Detail layers (resources/services, integrations, deployments, component catalog, service links)
  // are available to EVERYONE — not gated behind admin/dev mode. (Dev "mode" still adds tooling/test
  // chips + the richer layout, and ⚙ Settings / Regenerate / drag-arrange stay admin-only.)
  // ONE build per change: buildGraph applies the layers + all facets itself and reports the status
  // options present before the status filter ran (facetOptions), so the Filters menu scopes its
  // options to the current view without a second build.
  const buildOpts = useMemo(
    () => ({ layers, facets, hiddenEdges, mode: viewMode, layout: layout[viewMode] || {}, groupBy }),
    [layers, facets, hiddenEdges, viewMode, layout, groupBy],
  )
  const graph = useMemo(
    () => (data ? buildGraph(data, buildOpts) : { nodes: [], edges: [], facetOptions: { status: [], components: [] }, edgeTypesPresent: [] }),
    [data, buildOpts],
  )
  const kindsPresent = useMemo(() => new Set(graph.nodes.map((n) => n.data.kind)), [graph])
  const facetKey = `${[...facets.group].sort().join(',')}|${[...facets.status].sort().join(',')}|${[...facets.health].sort().join(',')}|${[...facets.hidden].sort().join(',')}`
  const flowKey = `${LAYERS.map((l) => (layers[l.key] ? 1 : 0)).join('')}-${viewMode}-${facetKey}-${[...hiddenEdges].sort().join(',')}-${data?.generatedAt || ''}`

  // React Flow owns node/edge state so it can persist measured dimensions
  // (controlled props without onNodesChange caused re-measure flicker + dropped clicks).
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([])

  // load a fresh layout when the graph (toggles/mode/data) changes. For admins, region boxes become
  // movable/resizable (NodeResizer) — inject the editable flag + the persist callback here.
  useEffect(() => {
    setRfNodes(
      graph.nodes.map((n) =>
        n.type === 'region'
          ? { ...n, draggable: admin, selectable: admin, focusable: admin, data: { ...n.data, editable: admin, onResize: (g) => setRegionGeom(n.id, g) } }
          : n,
      ),
    )
    setRfEdges(graph.edges)
  }, [graph, admin, setRegionGeom, setRfNodes, setRfEdges])

  // (F) search → reuse the focus (lit/dim) mechanism to spotlight matches. searchList keeps the
  // graph order so the count + ‹/› stepper walk matches predictably.
  const searchList = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return graph.nodes.filter((n) => n.type === 'card' && `${n.data.title} ${n.data.subtitle || ''}`.toLowerCase().includes(q)).map((n) => n.id)
  }, [query, graph])
  const searchMatches = useMemo(() => (searchList.length ? new Set(searchList) : null), [searchList])
  const [matchIdx, setMatchIdx] = useState(0)
  useEffect(() => setMatchIdx(0), [query])
  // clamp when the list shrinks after a graph rebuild (filter/layer toggle) — otherwise the
  // "n/m" counter can read past the end (e.g. "5/3") and Enter steps land modulo-arbitrarily
  useEffect(() => setMatchIdx((i) => (searchList.length && i >= searchList.length ? 0 : i)), [searchList])

  // Filter options. Group is the fixed team taxonomy (always offer every cluster). Status is scoped
  // to the CURRENT view: on the graph only statuses that actually have a node (reported by the build
  // itself, pre-status-filter) are offered, so ticking one always narrows a visible set and never
  // blanks the canvas. The Table/Matrix cover the full inventory, so there Status draws from every entry.
  const facetOptions = useMemo(() => {
    const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort()
    return {
      group: clusterDefs.map((c) => c.label),
      status: view === 'graph' ? graph.facetOptions?.status || [] : uniq((data?.inventory || []).map((e) => e.status)),
      // graph: the hideable cards on the current map (reported by the build); Table/Matrix: every
      // inventory component (the list can reach ~136 rows, hence the text filter + scroll cap).
      components: view === 'graph' ? graph.facetOptions?.components || [] : uniq((data?.inventory || []).map((e) => e.name)),
    }
  }, [view, graph, data, clusterDefs])
  // inventory filtered by the same group + status + health facets, for the Table / Matrix views.
  // Normalize first so an all-selected facet equals none-selected (same rule the graph applies).
  const facetInventory = useMemo(() => {
    const uniq = (xs) => [...new Set(xs.filter(Boolean))]
    const groupOpts = clusterDefs.map((c) => c.label)
    const statusOpts = uniq((data?.inventory || []).map((e) => e.status))
    const hideOpts = uniq((data?.inventory || []).map((e) => String(e.name).toLowerCase()))
    const eff = {
      ...facets,
      group: coversAll(facets.group, groupOpts) ? new Set() : facets.group,
      status: coversAll(facets.status, statusOpts) ? new Set() : facets.status,
      hidden: coversAll(facets.hidden, hideOpts) ? new Set() : facets.hidden,
    }
    return (data?.inventory || []).filter((e) => matchInventory(e, eff, clusterDefs))
  }, [data, facets, clusterDefs])
  // repo basename -> auto-detected integrations (data.repos[].externals), for the Table's
  // Integrations column. Inventory `repoName` === repo `folder`, so this keys cleanly.
  const externalsByRepo = useMemo(() => {
    const m = {}
    for (const r of data?.repos || []) if (r.externals?.length) m[r.folder] = r.externals
    return m
  }, [data])

  // Integration protocol -> arrow-type key, so the Filters "Arrows / integrations" toggles apply to
  // the Integrations table too (hiding "Kafka" drops both the graph's Kafka arrows and the table's
  // Kafka rows). Which arrow types are actually present in the integration data drives the toggles
  // shown while the Integrations view is active.
  const integrationEdgeTypes = useMemo(() => [...new Set((data?.integrations || []).map((i) => PROTOCOL_EDGE[i.protocol]).filter(Boolean))], [data])
  const visibleIntegrations = useMemo(
    () =>
      (data?.integrations || []).filter((i) => {
        const t = PROTOCOL_EDGE[i.protocol]
        return !t || !hiddenEdges.has(t)
      }),
    [data, hiddenEdges],
  )

  // The graph node id of the currently-selected single component, so selecting a card dims everything
  // that isn't it or a direct neighbour — the same treatment as hovering. Region selections drive
  // `blockFocus` instead; screen / other-panel selections have no node and yield null.
  const selId = useMemo(() => {
    if (!sel || sel.region || sel.screen) return null
    const byRef = graph.nodes.find((n) => n.data === sel)
    if (byRef) return byRef.id
    const key = sel.repo?.serviceId || sel.repo?.folder || sel.resource?.id
    return key ? (graph.nodes.find((n) => matchSelNode(n, key))?.id ?? null) : null
  }, [sel, graph])

  // focus (dim everything else) = hovered node > search hits > a clicked block's members > the selected
  // card. Facets are a true filter now (they remove non-matching nodes in buildGraph), so they no
  // longer drive dimming.
  const focusNodes = useMemo(() => {
    if (hoverId) return new Set([hoverId])
    if (searchMatches) return searchMatches
    if (blockFocus) return blockFocus
    if (selId) return new Set([selId])
    return null
  }, [hoverId, searchMatches, blockFocus, selId])

  const lit = useMemo(() => {
    if (!focusNodes) return null
    const ln = new Set(focusNodes),
      le = new Set()
    for (const e of graph.edges)
      if (focusNodes.has(e.source) || focusNodes.has(e.target)) {
        le.add(e.id)
        ln.add(e.source)
        ln.add(e.target)
      }
    return { ln, le }
  }, [focusNodes, graph])

  // apply focus by mutating ONLY className (spreads existing nodes -> keeps measured dims -> no flicker)
  useEffect(() => {
    setRfNodes((nds) => nds.map((n) => (n.type === 'region' ? n : { ...n, className: !lit ? undefined : lit.ln.has(n.id) ? 'lit' : 'dim' })))
    setRfEdges((eds) =>
      eds.map((e) => {
        const cls = !lit ? undefined : lit.le.has(e.id) ? 'lit' : 'dim'
        return { ...e, className: cls, data: { ...e.data, dim: cls === 'dim' } } // portal-rendered labels read data.dim
      }),
    )
  }, [lit, setRfNodes, setRfEdges])

  // (G) keep the URL query in sync so the current view is shareable. Everything serializes as its
  // DEVIATION from the default: layer params are omitted at their default and written `=1`/`=0`
  // otherwise (so a default-on layer switched OFF survives a reload/share); `group` is omitted when
  // it matches the default-on set, and an explicit empty `?group=` when the user cleared it to show
  // every group. `status`/`risk` have no default, so plain presence is enough.
  const defaultGroups = useMemo(() => new Set(defaultOnLabels(clusterDefs)), [clusterDefs])
  const groupParam = useMemo(() => {
    const cur = [...facets.group].sort()
    const def = [...defaultGroups].sort()
    return cur.length === def.length && cur.every((l, i) => l === def[i]) ? null : cur.join(',')
  }, [facets.group, defaultGroups])
  // Build the URLSearchParams that mirror the current view — the single source shared by the URL-sync
  // effect below, the Copy-link button, and saved named views. Everything serializes as its DEVIATION
  // from the default (see the layer/group notes above), so a default view yields an empty query.
  const buildViewParams = useCallback(() => {
    const p = new URLSearchParams()
    for (const l of LAYERS) if (layers[l.key] !== l.default) p.set(l.param, layers[l.key] ? '1' : '0')
    if (facets.health.size) p.set('risk', '1')
    if (dark !== cfgDark) p.set('dark', dark ? '1' : '0')
    if (groupParam != null) p.set('group', groupParam)
    if (facets.status.size) p.set('status', [...facets.status].join(','))
    if (facets.hidden.size) p.set('hide', [...facets.hidden].join(','))
    if (hiddenEdges.size) p.set('hedge', [...hiddenEdges].join(','))
    if (viewMode !== cfgMode) p.set('mode', viewMode)
    if (view !== cfgView) p.set('view', view)
    if (groupBy !== 'team') p.set('by', groupBy)
    if (clientId) p.set('client', clientId)
    if (sel?.repo?.folder || sel?.resource?.id) p.set('sel', sel.repo?.serviceId || sel.repo?.folder || sel.resource.id)
    // catalog cards and the Kafka bus are selectable too — write their node ids so those
    // selections share/restore like any other (matchSelNode resolves them by exact id)
    else if (sel?.inventory?.name) p.set('sel', 'inv:' + sel.inventory.name)
    else if (sel?.kind === 'bus') p.set('sel', 'bus:kafka')
    if (EMBED) p.set('embed', '1') // stay in kiosk mode across in-iframe reloads
    return p
  }, [groupParam, layers, dark, view, sel, facets, hiddenEdges, clientId, viewMode, cfgDark, cfgMode, cfgView, groupBy])
  useEffect(() => {
    const qs = buildViewParams().toString()
    history.replaceState(null, '', qs ? '?' + qs : location.pathname)
  }, [buildViewParams])
  // Apply a saved/shared query string to the live view by driving the EXISTING setters — the inverse of
  // buildViewParams, using the same qFlag/qList semantics as the initial URL seed so a saved view
  // round-trips exactly. Restores the whole captured slice (layers, facets, arrow toggles, theme, mode,
  // view, drill-down, selection); anything the query omits falls back to that field's default.
  // A saved view's ?sel= may name a node that only exists AFTER the view's layers/facets rebuild
  // the graph (e.g. the view enables the Resources layer and selects a backend). applyViewParams
  // stashes the unresolved id here and this effect resolves it against the next build — one
  // attempt only, so an id that's truly gone can't hijack an unrelated later rebuild.
  const pendingSelRef = useRef(null)
  useEffect(() => {
    if (pendingSelRef.current == null) return
    const id = pendingSelRef.current
    pendingSelRef.current = null
    const n = graph.nodes.find((x) => matchSelNode(x, id))
    if (n) setSel(n.data)
  }, [graph])
  const applyViewParams = useCallback(
    (qs) => {
      const p = new URLSearchParams(qs)
      const flag = (k, dflt) => (p.has(k) ? p.get(k) === '1' : dflt)
      const list = (k) => (p.has(k) ? (p.get(k) || '').split(',').filter(Boolean) : null)
      setLayers(Object.fromEntries(LAYERS.map((l) => [l.key, flag(l.param, l.default)])))
      setFacets({
        group: new Set(list('group') ?? defaultOnLabels(clusterDefs)),
        status: new Set(list('status') ?? []),
        health: new Set(flag('risk', false) ? ['at-risk'] : []),
        hidden: new Set((list('hide') ?? []).map((s) => s.toLowerCase())),
      })
      setHiddenEdges(new Set(list('hedge') ?? []))
      // omitted params fall back to the CONFIG defaults (what buildViewParams serialized against),
      // not the built-ins — a view saved at the config default must restore to it.
      setDark(flag('dark', cfgDark))
      setMode(p.has('mode') ? (p.get('mode') === 'overview' ? 'overview' : 'dev') : cfgMode)
      const v = p.get('view') || cfgView
      setView(VIEWS.includes(v) ? v : 'graph')
      const by = p.get('by')
      setGroupBy(by === 'application' || by === 'platform' ? by : 'team')
      setClientId(p.get('client') || null)
      const selId = p.get('sel')
      if (!selId) setSel(null)
      else {
        const n = graph.nodes.find((x) => matchSelNode(x, selId))
        if (n) setSel(n.data)
        else pendingSelRef.current = selId // not in the pre-apply graph — resolve after the rebuild
      }
    },
    [clusterDefs, graph, cfgDark, cfgMode, cfgView],
  )

  // (G) restore a selected node from the URL once the graph is built
  const restoredSel = React.useRef(false)
  useEffect(() => {
    if (restoredSel.current || !graph.nodes.length) return
    const id = qStr('sel', null)
    if (id) {
      const n = graph.nodes.find((x) => matchSelNode(x, id))
      if (n) {
        setSel(n.data)
        if (EMBED) setTimeout(() => frameNodes([n.id]), 300) // embed: open zoomed to the framed node
      }
    }
    restoredSel.current = true
  }, [graph])

  // (E) pipeline-health: validation block from assemble + any Unclassified repos in the layout
  const health = useMemo(() => {
    const v = data?.validation || {}
    const unclassified = graph.nodes.find((n) => n.id === 'region-Unclassified')?.data.members || []
    const items = []
    if (unclassified.length) items.push({ kind: 'Unclassified repos (no cluster assigned)', list: unclassified })
    if (v.newlyDiscovered?.length) items.push({ kind: 'New repos (created on GitHub recently — double-check curation)', list: v.newlyDiscovered })
    if (v.unclonedOrgRepos?.length) items.push({ kind: `On ${data?.org || 'the'} org but not cloned locally`, list: v.unclonedOrgRepos })
    if (v.staleClones?.length) items.push({ kind: 'Clones with no readable git history', list: v.staleClones })
    if (v.duplicateClones?.length) items.push({ kind: 'Duplicate local clones of one repo (stale pre-rename folder)', list: v.duplicateClones })
    if (v.repoRenames?.length) items.push({ kind: 'GitHub repos renamed (curated names auto-fixed at runtime)', list: v.repoRenames })
    if (v.repoMissingOnGitHub?.length) items.push({ kind: 'GitHub repos not found (deleted or no access)', list: v.repoMissingOnGitHub })
    if (v.uncuratedRepos?.length) items.push({ kind: 'Org repos with no inventory topics (not on the map — curate to include)', list: v.uncuratedRepos })
    if (v.incompleteCuration?.length) items.push({ kind: 'On the map but half-curated (missing owner/status/description)', list: v.incompleteCuration })
    if (v.statusMismatch?.length) items.push({ kind: 'Archived on GitHub but status not Removed (to be curated)', list: v.statusMismatch })
    if (v.azureStaleMappings?.length) items.push({ kind: 'Stale Azure name mappings (repo-extra.json)', list: v.azureStaleMappings })
    // Azure drift (assemble.mjs azure overlay) — what's actually deployed vs what's curated
    if (v.azureUnmappedApps?.length) items.push({ kind: 'Deployed in Azure but not on the map', list: v.azureUnmappedApps })
    if (v.azureEnvDrift?.length) items.push({ kind: 'Environment drift (Azure vs workflows)', list: v.azureEnvDrift })
    if (v.azureRemovedButDeployed?.length) items.push({ kind: 'Removed/Sunsetting but recently deployed', list: v.azureRemovedButDeployed })
    if (v.azureNeedsCuration?.length) items.push({ kind: 'Deployed services awaiting curation (scaffolded into the table)', list: v.azureNeedsCuration })
    if (v.azureAcrNotInInventory?.length) items.push({ kind: 'In container registry, no matching GitHub repo', list: v.azureAcrNotInInventory })
    return { items, count: items.reduce((s, i) => s + i.list.length, 0) }
  }, [data, graph])

  // (H) export the current diagram view to a PNG
  const exportPng = useCallback(async () => {
    const vp = document.querySelector('.react-flow__viewport')
    // no canvas in Table/Matrix/Integrations — say so instead of silently doing nothing
    if (!vp) return setToast('Export captures the Graph view — switch to Graph first')
    setBusy('Export')
    try {
      // html-to-image is only needed for export — load it on demand so it stays out of the main bundle
      const { toPng } = await import('html-to-image')
      const url = await toPng(vp, {
        backgroundColor: dark ? '#0c1322' : '#f4f6fa',
        pixelRatio: 2,
        width: vp.scrollWidth || undefined,
        height: vp.scrollHeight || undefined,
      })
      const a = document.createElement('a')
      a.href = url
      a.download =
        (title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'repo-atlas') + '.png'
      a.click()
      setToast('Exported PNG')
    } catch (e) {
      setToast('Export failed — ' + String(e.message || e).slice(0, 120))
    } finally {
      setBusy(null)
    }
  }, [dark, title])

  // download the exact data object that feeds the app (the served model), so it can be handed to
  // Claude / inspected directly. JSON is the canonical form the pipeline emits.
  const downloadData = useCallback(() => {
    if (!data) return
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'repo-atlas-data.json'
    a.click()
    URL.revokeObjectURL(url)
    setToast('Downloaded data (JSON)')
  }, [data])

  // copy a shareable link to the current view (the URL already mirrors filters/mode/selection)
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
      const r = await fetch(endpoint, { method: 'POST' })
      const body = await r.json()
      if (!r.ok || body.ok === false) throw new Error(JSON.stringify(body.log || body.error || body))
      if (endpoint === '/api/regenerate') {
        await load()
        setToast('Regenerated — data refreshed')
      } else setToast('Published to ' + body.path)
    } catch (e) {
      setToast(label + ' failed (is the dev server running?) — ' + String(e.message || e).slice(0, 200))
    } finally {
      setBusy(null)
    }
  }

  const onNodeClick = useCallback(
    (_, node) => {
      if (node.type === 'region') {
        const ids = node.data.members || []
        const idset = new Set(ids)
        const members = graph.nodes
          .filter((n) => n.type === 'card' && idset.has(n.id))
          .map((n) => ({ id: n.id, title: String(n.data.title).replace('\n', ' '), kind: n.data.kind }))
        setBlockFocus(new Set(ids))
        setSel({ region: { label: node.data.label, color: node.data.color, members, note: config.regionNotes?.[node.data.label] || '' } })
      } else {
        setSel(node.data)
        setBlockFocus(null)
      }
    },
    [graph, config],
  )
  // double-click a client card to drill into its per-screen view (single click still selects)
  const onNodeDoubleClick = useCallback(
    (_, node) => {
      const folder = node.data?.repo?.folder
      if (node.type === 'card' && node.data?.kind === 'client' && data?.extras?.screens?.perRepo?.[folder]?.screens?.length) {
        setClientId(folder)
      }
    },
    [data],
  )
  // open a screen's detail (from the drill-down view) in the side panel
  const onSelectScreen = useCallback((screen, clientTitle) => {
    if (screen) setSel({ screen, clientTitle })
  }, [])
  // smoothly frame a set of node ids in the graph viewport (used by search + cross-navigation)
  const frameNodes = useCallback((ids) => {
    if (!ids?.length) return
    rfRef.current?.fitView({ nodes: ids.map((id) => ({ id })), duration: 450, padding: 0.5, maxZoom: 1.3 })
  }, [])
  // cross-navigation from the Details panel: resolve a key (node id, repo FOLDER or serviceId via
  // matchSelNode — adoption chips are keyed by folder, which stopped being the node id for
  // serviceId-keyed repos (#16) — internal pkg name, or repo name) to a card, select it, and
  // frame it. No-op if that node isn't currently on the map.
  const navigateTo = useCallback(
    (key) => {
      if (!key) return
      const nodes = graph.nodes
      const n =
        nodes.find((x) => x.id === key) ||
        nodes.find((x) => matchSelNode(x, key)) ||
        nodes.find((x) => x.data?.repo?.name === key) ||
        (uiPackagesOf(config).has(key) && nodes.find((x) => uiHubFoldersOf(config).includes(x.id))) ||
        nodes.find((x) => x.id === 'pkg:' + key)
      if (!n || n.type === 'region') return
      setSel(n.data)
      setBlockFocus(null)
      frameNodes([n.id])
    },
    [graph, frameNodes],
  )
  // search result stepper: cycle to the next/prev match, framing + selecting it
  const stepMatch = useCallback(
    (dir) => {
      if (!searchList.length) return
      const next = (matchIdx + dir + searchList.length) % searchList.length
      setMatchIdx(next)
      const n = graph.nodes.find((x) => x.id === searchList[next])
      if (n) setSel(n.data)
      frameNodes([searchList[next]])
    },
    [searchList, matchIdx, graph, frameNodes],
  )
  const onNodeEnter = useCallback((_, node) => {
    if (node.type !== 'region') setHoverId(node.id)
  }, [])
  const onNodeLeave = useCallback(() => setHoverId(null), [])
  // admin-only: remember where a card was dropped so it survives rebuilds + can be published.
  // Positions are scoped to the current view-mode (dev / overview).
  const onNodeDragStop = useCallback(
    (_, node) => {
      setHelper(NO_HELPER)
      if (node.type === 'region') {
        // keep the box's current size; only the position moved
        const cur = (layout[viewMode] || {})[node.id] || {}
        const w = cur.w ?? Math.round(node.measured?.width ?? node.width ?? 0)
        const h = cur.h ?? Math.round(node.measured?.height ?? node.height ?? 0)
        setRegionGeom(node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y), w, h })
        return
      }
      pushUndo()
      setLayout((l) => ({ ...l, [viewMode]: { ...l[viewMode], [node.id]: { x: Math.round(node.position.x), y: Math.round(node.position.y) } } }))
    },
    [pushUndo, viewMode, setRegionGeom, layout],
  )
  const resetLayout = useCallback(() => {
    pushUndo()
    setLayout(EMPTY_LAYOUT)
  }, [pushUndo])
  // re-flow just this view back to the computed layout (clears the current mode's overrides)
  const autoArrange = useCallback(() => {
    pushUndo()
    setLayout((l) => ({ ...l, [viewMode]: {} }))
  }, [pushUndo, viewMode])
  const undoLayout = useCallback(() => {
    const prev = layoutUndo.current.pop()
    if (prev) setLayout(prev)
  }, [])
  // Cmd/Ctrl+Z undoes the last admin drag / re-flow (ignored while typing in a field)
  useEffect(() => {
    if (!admin) return
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault()
        undoLayout()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [admin, undoLayout])
  // admin drag: snap a dragged card to align with its neighbours (Figma-style guides) on top of the
  // grid snap, and surface the guide lines. Falls through to the default change handler otherwise.
  const onNodesChangeAdmin = useCallback(
    (changes) => {
      const c = changes[0]
      if (admin && changes.length === 1 && c.type === 'position' && c.dragging && c.position) {
        const { horizontal, vertical, color, snapPosition } = getHelperLines(c, rfNodes)
        if (snapPosition.x != null) c.position.x = snapPosition.x
        if (snapPosition.y != null) c.position.y = snapPosition.y
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
  // clicking a dependency / service edge spotlights its two endpoints (reuses the focus mechanism)
  const onEdgeClick = useCallback((_, edge) => {
    setBlockFocus(new Set([edge.source, edge.target]))
    setSel(null)
  }, [])
  // right-click context menu (admin only). Capture the cursor + target; the item list is built at
  // render time (buildCtxItems) so it reflects the current node/pane and available actions.
  const onNodeContextMenu = useCallback(
    (e, node) => {
      if (!admin) return
      e.preventDefault()
      setCtx({ x: e.clientX, y: e.clientY, node })
    },
    [admin],
  )
  const onPaneContextMenu = useCallback(
    (e) => {
      if (!admin) return
      e.preventDefault()
      setCtx({ x: e.clientX, y: e.clientY, node: null })
    },
    [admin],
  )
  const fitView = useCallback(() => rfRef.current?.fitView({ duration: 450, padding: 0.15 }), [])
  const extras = data?.extras

  // Badges. Layers = how many detail layers are switched on (additive; adds node types). Filters = how
  // many narrowing selections are active (each ticked group + status + health value). Counting what's
  // ON means clearing everything reads 0.
  // Detail layers and the arrow / integration toggles are now folded into the Filters dropdown, so
  // their non-default state counts toward the Filters badge and clears on Reset.
  const layerDeviations = view === 'graph' ? LAYERS.filter((l) => layers[l.key] !== l.default).length : 0
  // hidden-arrow toggles count only where the Arrows section exists (Graph/Integrations) — in
  // Table/Matrix the badge would otherwise show a count the open menu can't explain
  const filterCount =
    facets.group.size +
    facets.status.size +
    facets.health.size +
    facets.hidden.size +
    layerDeviations +
    (view === 'graph' || view === 'integrations' ? hiddenEdges.size : 0)
  // At the default view when the group matches the default-on set (groupParam null), no status/health/
  // hidden value is picked, no arrow class is hidden, and (in Graph) the detail layers are at their
  // defaults. Anything else is a deviation the "Reset filters" button returns from — including a
  // clear-everything (empty group).
  const isDefaultFilters = groupParam == null && !facets.status.size && !facets.health.size && !facets.hidden.size && !layerDeviations && !hiddenEdges.size
  // "Reset filters" returns to the default view — the default-on groups (ISS/IoT hidden), no status,
  // no at-risk, no hidden components, every arrow class shown, and the default detail layers.
  const resetFilters = useCallback(() => {
    setFacets({ group: new Set(defaultGroups), status: new Set(), health: new Set(), hidden: new Set() })
    setLayers(Object.fromEntries(LAYERS.map((l) => [l.key, l.default])))
    setHiddenEdges(new Set())
  }, [defaultGroups])

  // unsaved-layout tracking for the canvas pill
  const layoutDirty = admin && JSON.stringify(layout) !== JSON.stringify(savedLayout)
  const modeLayoutCount = Object.keys(layout[viewMode] || {}).length

  if (!data && denied)
    return (
      <div className={'app' + (dark ? ' dark' : '')}>
        <div className="loading" role="alert">
          <div>
            <p>
              <b>You're signed in, but your account can't read the architecture data.</b>
            </p>
            <p>
              The data API requires an access role ({denied}). Ask IT to assign it to your account, then{' '}
              <button className="btn" onClick={() => location.reload()}>
                reload
              </button>
              .
            </p>
          </div>
        </div>
      </div>
    )
  if (!data && enc)
    return (
      <div className={'app' + (dark ? ' dark' : '')}>
        <Gate onUnlock={unlock} error={gateError} busy={gateBusy} />
      </div>
    )

  // Build the right-click menu for the captured target. Regions get geometry actions; cards get
  // navigation/links; the empty pane gets whole-view layout actions. Admin-only (the handlers bail
  // for non-admins), so edit actions are always available here.
  const buildCtxItems = () => {
    if (!ctx) return []
    const node = ctx.node
    if (node?.type === 'region') {
      const label = node.data.label
      return [
        { heading: label + ' group' },
        { label: 'Select group', icon: 'box', onClick: () => onNodeClick(null, node) },
        { label: 'Resize to fit members', icon: 'integrations', onClick: () => resizeRegionToFit(node.id, node.data.members) },
        { label: 'Reset box to auto', icon: 'dot', onClick: () => clearRegionGeom(node.id), disabled: !(layout[viewMode] || {})[node.id] },
        { separator: true },
        { label: 'Edit group descriptions…', icon: 'edit', onClick: () => setShowAdmin(true) },
      ]
    }
    if (node) {
      const d = node.data
      const repoUrl = d.inventory?.repo || d.repo?.remote?.replace(/\.git$/, '') || null
      const dh = docHref(d.inventory?.doc, d.inventory?.docUrl, config?.docSearchUrl)
      const canDrill = d.kind === 'client' && data?.extras?.screens?.perRepo?.[d.repo?.folder]?.screens?.length
      return [
        { heading: String(d.title || '').replace('\n', ' ') },
        { label: 'Details', icon: 'more', onClick: () => onNodeClick(null, node) },
        { label: 'Focus / frame', icon: 'search', onClick: () => frameNodes([node.id]) },
        canDrill ? { label: 'View screens →', icon: 'integrations', onClick: () => setClientId(d.repo.folder) } : null,
        { separator: true },
        { label: 'Open repo on GitHub', icon: 'github', onClick: () => window.open(repoUrl, '_blank', 'noopener'), disabled: !repoUrl },
        { label: 'Open documentation', icon: 'book', onClick: () => window.open(dh, '_blank', 'noopener'), disabled: !dh },
      ]
    }
    return [
      { heading: 'Canvas' },
      { label: 'Fit view', icon: 'search', onClick: fitView },
      { label: 'Auto-arrange this view', icon: 'rocket', onClick: autoArrange },
      { separator: true },
      { label: 'Reset all layout', icon: 'close', danger: true, onClick: resetLayout },
    ]
  }

  return (
    <div className={'app' + (dark ? ' dark' : '') + (EMBED ? ' embed' : '')}>
      <header className={'toolbar' + (EMBED ? ' embed' : '')}>
        <div className="brand">
          {logoUrl ? <img className="brand-logo" src={logoUrl} alt="" /> : <span className="brand-mark" />}
          <span className="brand-text">{title}</span>
          {subtitle ? <span className="brand-sub">{subtitle}</span> : null}
          {data?.generatedAt
            ? (() => {
                const days = Math.floor((Date.now() - new Date(data.generatedAt).getTime()) / 86400000)
                const ago = days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`
                return (
                  <span className={'gen' + (days > dataStaleDays ? ' old' : '')} title={new Date(data.generatedAt).toLocaleString()}>
                    data {ago}
                  </span>
                )
              })()
            : null}
        </div>
        {EMBED ? (
          <>
            <div className="spacer" />
            <a
              className="btn ghost embed-fullmap"
              href={(() => {
                const p = new URLSearchParams(location.search)
                p.delete('embed')
                const qs = p.toString()
                return location.origin + location.pathname + (qs ? '?' + qs : '')
              })()}
              target="_blank"
              rel="noreferrer"
              title="Open the full interactive map in a new tab"
            >
              <Icon name="external" /> Open full map
            </a>
            <button
              className="btn ghost"
              onClick={() => setDark((d) => !d)}
              title="Toggle theme"
              aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              <Icon name={dark ? 'sun' : 'moon'} />
            </button>
          </>
        ) : (
          <>
            <Dropdown className="view-dd" label={VIEW_LABELS[view]} title="Switch view">
              {(close) =>
                Object.entries(VIEW_LABELS).map(([v, label]) => (
                  <button
                    key={v}
                    className={'dd-item' + (view === v ? ' on' : '')}
                    onClick={() => {
                      setView(v)
                      setClientId(null) // switching the map view exits any per-client drill-down
                      close()
                    }}
                  >
                    {label}
                  </button>
                ))
              }
            </Dropdown>
            {admin ? (
              <label className="switch" title="Show extra detail (tooling/test chips + the richer layout)">
                <input type="checkbox" checked={mode === 'dev'} onChange={(e) => setMode(e.target.checked ? 'dev' : 'overview')} />
                <span className="switch-track">
                  <span className="switch-thumb" />
                </span>
                <span className="switch-label">Detail</span>
              </label>
            ) : null}
            {/* Group by — which taxonomy the graph's lanes follow. Layout-only: the Group FILTER
                below always stays the team taxonomy, so grouping and filtering compose. */}
            {view === 'graph' ? (
              <Dropdown
                className="groupby-dd"
                label={GROUP_BY_LABELS[groupBy]}
                title="Group the graph's lanes by team, application or platform (config.json `platforms`)"
              >
                {(close) =>
                  Object.entries(GROUP_BY_LABELS).map(([v, label]) => (
                    <button
                      key={v}
                      className={'dd-item' + (groupBy === v ? ' on' : '')}
                      onClick={() => {
                        setGroupBy(v)
                        close()
                      }}
                    >
                      {label}
                    </button>
                  ))
                }
              </Dropdown>
            ) : null}
            {/* Filters — one control: faceted narrowing (group/status/health, subtractive) plus the graph
                detail layers (additive), folded in here so there's a single menu instead of two. */}
            <Dropdown className="filters-dd" label="Filters" badge={filterCount || null} title="Narrow or detail the map — groups, status, health, layers">
              {isDefaultFilters ? (
                <div className="dd-hint">Default view. Tick a group or status to narrow, or untick every group to show all.</div>
              ) : (
                <button className="dd-item dd-clear" onClick={resetFilters}>
                  <Icon name="close" /> Reset filters (default view)
                </button>
              )}
              <div className="dd-group">Group (team)</div>
              {facetOptions.group.map((label) => {
                const def = clusterDefs.find((c) => c.label === label)
                return (
                  <FilterRow key={'g:' + label} checked={facets.group.has(label)} onChange={() => toggleFacet('group', label)}>
                    {def?.color ? <span className="tagdot" style={{ background: def.color }} /> : null}
                    {label}
                  </FilterRow>
                )
              })}
              {facetOptions.status.length ? (
                <>
                  <div className="dd-group">Status</div>
                  {facetOptions.status.map((s) => (
                    <FilterRow key={'s:' + s} checked={facets.status.has(s)} onChange={() => toggleFacet('status', s)}>
                      {s}
                    </FilterRow>
                  ))}
                </>
              ) : null}
              <div className="dd-group">Health</div>
              <FilterRow checked={facets.health.has('at-risk')} onChange={() => toggleFacet('health', 'at-risk')}>
                <span className="tagdot" style={{ background: '#b3261e' }} />
                At-risk only (alerts / failing CI)
              </FilterRow>
              {/* Detail (graph-only, additive) — each toggle draws an extra class of nodes on top of the
                  base repo/service map. Deliberately NOT called "Layer": that word was ambiguous with the
                  inventory's Type, so it's graph-only "Detail" now. */}
              {view === 'graph' ? (
                <>
                  <div className="dd-group">Detail (graph only)</div>
                  <div className="dd-subhint">Each adds a class of nodes on top of the base map. Untick all to return to the base map.</div>
                  {LAYERS.map((l) => (
                    <FilterRow key={'l:' + l.key} checked={layers[l.key]} onChange={(on) => toggleLayer(l.key, on)}>
                      {l.label}
                    </FilterRow>
                  ))}
                </>
              ) : null}
              {/* Arrows / integrations — show/hide each arrow class present on the map (moved here from
                  the on-canvas Legend, which is now a pure key). Hiding an arrow type also drops nodes
                  it leaves edge-less (orphan prune in buildGraph), so e.g. hiding Kafka removes the bus
                  node too. Also applied to the Integrations table view (REST/Kafka rows). */}
              {(() => {
                // Which arrow types the toggles cover in the current view: on the graph, every class
                // drawn; in the Integrations table, just the protocols present there. Other views have
                // no arrows, so the section is hidden.
                const arrowKeys = view === 'graph' ? graph.edgeTypesPresent || [] : view === 'integrations' ? integrationEdgeTypes : []
                if (!arrowKeys.length) return null
                return (
                  <>
                    <div className="dd-group">Arrows / integrations</div>
                    {edgeTypesFor(config)
                      .filter((e) => arrowKeys.includes(e.key))
                      .map((e) => (
                        <FilterRow key={'e:' + e.key} checked={!hiddenEdges.has(e.key)} onChange={() => toggleEdge(e.key)}>
                          <span className="legend-edge" style={{ borderTopColor: e.color, borderTopStyle: e.dash }} />
                          {e.label}
                        </FilterRow>
                      ))}
                  </>
                )
              })()}
              {/* Components — show/hide individual inventory components. Scoped to the current view
                  (graph nodes / full inventory); a hidden item stays listed so it can be re-checked.
                  Keyed by lowercased inventory name (matches matchInventory + buildGraph). */}
              {facetOptions.components.length
                ? (() => {
                    const shown = facetOptions.components.filter((name) => name.toLowerCase().includes(compFilter.trim().toLowerCase()))
                    return (
                      <>
                        <div className="dd-group">
                          Components
                          {/* Only a "Show all" — clearing the whole hidden set. There's deliberately no
                              "hide all": unchecking every component is symmetric with checking every one
                              (both show all — see graph.js), so a hide-all button would be a no-op. */}
                          {facets.hidden.size ? (
                            <span className="dd-group-actions">
                              <button className="dd-linkbtn" onClick={() => setComponentsHidden([...facets.hidden], false)}>
                                Show all
                              </button>
                            </span>
                          ) : null}
                        </div>
                        <input
                          className="dd-filter"
                          type="search"
                          value={compFilter}
                          placeholder="Filter components…"
                          onChange={(e) => setCompFilter(e.target.value)}
                        />
                        <div className="dd-scroll">
                          {shown.map((name) => (
                            <FilterRow
                              key={'c:' + name}
                              checked={!facets.hidden.has(name.toLowerCase())}
                              onChange={() => toggleFacet('hidden', name.toLowerCase())}
                            >
                              {name}
                            </FilterRow>
                          ))}
                        </div>
                      </>
                    )
                  })()
                : null}
            </Dropdown>
            <div className="search-wrap">
              <Icon name="search" className="search-icon" />
              <input
                className="search"
                type="search"
                value={query}
                placeholder={view === 'table' ? 'Filter inventory…' : view === 'integrations' ? 'Filter integrations…' : 'Search repos…'}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && view === 'graph') {
                    if (e.shiftKey) stepMatch(-1)
                    else if (searchList.length > 1) stepMatch(1)
                    else frameNodes(searchList)
                  }
                }}
                title="Highlight matching cards — Enter to step through matches"
              />
              {query && view === 'graph' ? (
                <span className="search-nav">
                  <span className="search-count">{searchList.length ? `${matchIdx + 1}/${searchList.length}` : '0'}</span>
                  {searchList.length ? (
                    <>
                      <button className="search-step" onClick={() => stepMatch(-1)} title="Previous match (Shift+Enter)" aria-label="Previous match">
                        <Icon name="prev" />
                      </button>
                      <button className="search-step" onClick={() => stepMatch(1)} title="Next match (Enter)" aria-label="Next match">
                        <Icon name="next" />
                      </button>
                    </>
                  ) : null}
                </span>
              ) : null}
            </div>
            <div className="spacer" />
            {health.count ? (
              <div className="health-wrap" ref={healthRef}>
                <button
                  className={'btn health' + (showHealth ? ' on' : '')}
                  onClick={() => setShowHealth((s) => !s)}
                  title="Pipeline warnings"
                  aria-label={`Pipeline warnings: ${health.count}`}
                  aria-expanded={showHealth}
                >
                  <Icon name="warning" /> {health.count}
                </button>
                {showHealth ? (
                  <div className="health-pop">
                    <div className="health-title">Pipeline health</div>
                    {health.items.map((it) => (
                      <div key={it.kind} className="health-item">
                        <div className="health-kind">{it.kind}</div>
                        <div className="chiprow">
                          {it.list.map((x) => (
                            <HealthChip key={x} token={x} org={data.org} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <span className="tb-sep" />
            <Dropdown className="views-dd" label="Views" badge={views.length || null} title="Save, apply or share named views">
              {(close) => (
                <>
                  <button
                    className="dd-item"
                    onClick={() => {
                      const name = window.prompt('Save current view as:')?.trim()
                      if (name) {
                        persistViews([...views.filter((v) => v.name !== name), { name, q: buildViewParams().toString() }])
                        setToast('Saved view “' + name + '”')
                      }
                      close()
                    }}
                  >
                    Save current…
                  </button>
                  <button
                    className="dd-item"
                    onClick={() => {
                      copyLink()
                      close()
                    }}
                  >
                    <Icon name="link" /> Copy link
                  </button>
                  {views.length ? <div className="dd-group">Saved views</div> : null}
                  {views.map((v) => (
                    <div key={v.name} className="views-row">
                      <button
                        className="dd-item views-apply"
                        onClick={() => {
                          applyViewParams(v.q)
                          close()
                        }}
                        title="Apply this view"
                      >
                        {v.name}
                      </button>
                      <button
                        className="btn ghost views-del"
                        onClick={() => persistViews(views.filter((x) => x.name !== v.name))}
                        title={'Delete ' + v.name}
                        aria-label={'Delete view ' + v.name}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  ))}
                </>
              )}
            </Dropdown>
            <button className="btn ghost" onClick={copyLink} title="Copy a shareable link to this exact view" aria-label="Copy shareable link">
              <Icon name="link" />
            </button>
            <button
              className="btn ghost"
              onClick={() => setShowEmbed(true)}
              title="Embed this view as an iframe (frames the current filtered slice)"
              aria-label="Embed this view"
            >
              <Icon name="code" />
            </button>
            {/* The one link into the Golden Path compliance screen (src/golden-path/, routed in
                main.jsx). A plain href, so it lands on that route with no map state in the URL.
                Hidden when there is no backend to serve its data (the static Pages build). */}
            {(import.meta.env.DEV || import.meta.env.VITE_DATA_URL) && (
              <a className="btn ghost" href="?view=golden-path" title="Golden Path compliance" aria-label="Golden Path compliance">
                <Icon name="compliance" />
              </a>
            )}
            <button className="btn ghost" onClick={() => setShowLegend(true)} title="Legend / help" aria-label="Legend and help">
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
              <button className="btn ghost" onClick={() => setShowAdmin(true)} title="Settings & curate the model (Admin)" aria-label="Settings — admin">
                <Icon name="gear" />
              </button>
            ) : null}
            <button
              className="btn ghost"
              onClick={() => setDark((d) => !d)}
              title="Toggle theme"
              aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              <Icon name={dark ? 'sun' : 'moon'} />
            </button>
            <span className="tb-sep" />
            {(() => {
              const user = getUser()
              return user ? (
                <div className="auth-chip" title={user.email || user.username || ''}>
                  <span className="auth-user">{user.name}</span>
                  <button className="btn ghost" onClick={logout} title="Sign out">
                    Logout
                  </button>
                </div>
              ) : null
            })()}
            <div className="actions">
              <button className="btn" disabled={!!busy} onClick={exportPng} title="Export current view to PNG">
                Export
              </button>
              {/* Regenerate/Publish hit the Vite dev-server API (vite.config.mjs); they don't exist in
              built deploys, so only show them under `npm run dev`. */}
              {import.meta.env.DEV && admin ? (
                <>
                  <button className="btn" disabled={!!busy} onClick={() => post('/api/regenerate', 'Regenerate')}>
                    {busy === 'Regenerate' ? 'Regenerating…' : 'Regenerate data'}
                  </button>
                  <button className="btn primary" disabled={!!busy} onClick={() => post('/api/publish', 'Publish')}>
                    {busy === 'Publish' ? 'Publishing…' : 'Publish diagram'}
                  </button>
                </>
              ) : null}
            </div>
            <Dropdown className="more-dd" label={<Icon name="more" />} caret={false} align="right" title="More actions">
              {(close) => (
                <>
                  <button
                    className="dd-item"
                    disabled={!!busy}
                    onClick={() => {
                      exportPng()
                      close()
                    }}
                  >
                    Export PNG
                  </button>
                  <button
                    className="dd-item"
                    onClick={() => {
                      downloadData()
                      close()
                    }}
                  >
                    Download data (JSON)
                  </button>
                  <button
                    className="dd-item"
                    onClick={() => {
                      setShowEmbed(true)
                      close()
                    }}
                  >
                    Embed this view…
                  </button>
                  {import.meta.env.DEV && admin ? (
                    <>
                      <button
                        className="dd-item"
                        disabled={!!busy}
                        onClick={() => {
                          post('/api/regenerate', 'Regenerate')
                          close()
                        }}
                      >
                        {busy === 'Regenerate' ? 'Regenerating…' : 'Regenerate data'}
                      </button>
                      <button
                        className="dd-item"
                        disabled={!!busy}
                        onClick={() => {
                          post('/api/publish', 'Publish')
                          close()
                        }}
                      >
                        {busy === 'Publish' ? 'Publishing…' : 'Publish diagram'}
                      </button>
                    </>
                  ) : null}
                </>
              )}
            </Dropdown>
          </>
        )}
      </header>

      {showLegend ? <LegendOverlay onClose={() => setShowLegend(false)} /> : null}
      {showEmbed ? <EmbedDialog title={title} onClose={() => setShowEmbed(false)} onCopied={() => setToast('Embed code copied to clipboard')} /> : null}
      {ctx && admin ? <ContextMenu x={ctx.x} y={ctx.y} items={buildCtxItems()} onClose={() => setCtx(null)} /> : null}
      {showAdmin && data && admin ? (
        <Suspense fallback={null}>
          <AdminPanel data={data} layout={layout} onResetLayout={resetLayout} onSaved={() => setSavedLayout(layout)} onClose={() => setShowAdmin(false)} />
        </Suspense>
      ) : null}

      <div className="body">
        {!data ? (
          <div className="loading" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>Loading architecture…</span>
          </div>
        ) : clientId ? (
          <Suspense
            fallback={
              <div className="loading" role="status" aria-live="polite">
                <span className="spinner" aria-hidden="true" />
              </div>
            }
          >
            <ClientDetailView
              data={data}
              folder={clientId}
              title={(() => {
                const r = data.repos?.find((x) => x.folder === clientId)
                return r?.inventory?.name || r?.displayName || clientId
              })()}
              dark={dark}
              onBack={() => {
                setClientId(null)
                if (sel?.screen) setSel(null)
              }}
              onSelectScreen={onSelectScreen}
            />
          </Suspense>
        ) : view === 'table' || view === 'matrix' || view === 'integrations' ? (
          (() => {
            const onSelect = (e) =>
              setSel({
                title: e.name,
                kind: e.type === 'Client' ? 'client' : /third/i.test(e.type) ? 'external' : 'component',
                subtitle: e.owner,
                inventory: e,
              })
            const fallback = (
              <div className="loading" role="status" aria-live="polite">
                <span className="spinner" aria-hidden="true" />
              </div>
            )
            return (
              <Suspense fallback={fallback}>
                {view === 'matrix' ? (
                  <MatrixView inventory={facetInventory} query={query} onSelect={onSelect} config={config} />
                ) : view === 'integrations' ? (
                  <IntegrationsTable integrations={visibleIntegrations} inventory={data?.inventory || []} query={query} onSelect={onSelect} />
                ) : (
                  <InventoryTable
                    inventory={facetInventory}
                    query={query}
                    onSelect={onSelect}
                    externals={externalsByRepo}
                    docSearchUrl={config?.docSearchUrl}
                  />
                )}
              </Suspense>
            )
          })()
        ) : (
          <div className="canvas" key={flowKey}>
            <ReactFlow
              onInit={(inst) => (rfRef.current = inst)}
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
              {admin ? <Background id="grid" variant="lines" gap={GRID} color={dark ? '#18233c' : '#eceef3'} /> : null}
              {admin ? <HelperLines horizontal={helper.h} vertical={helper.v} color={helper.color} /> : null}
              {EMBED ? null : <MiniMap pannable zoomable nodeColor={(n) => KIND[n.data?.kind]?.color || '#bbb'} />}
              <Controls />
            </ReactFlow>
            {admin && (layoutDirty || modeLayoutCount > 0) ? (
              <div className="layout-pill">
                <span className="layout-pill-txt">
                  {layoutDirty ? <Icon name="dot" className="pill-dot" /> : null} {layoutDirty ? 'Layout changed' : 'Custom layout'}
                </span>
                <button className="btn ghost" onClick={autoArrange} title="Re-flow this view to the automatic layout">
                  Auto-arrange
                </button>
                {layoutDirty ? (
                  <button className="btn primary" onClick={() => setShowAdmin(true)} title="Open Admin to save the layout to config.json">
                    Save…
                  </button>
                ) : null}
              </div>
            ) : null}
            {EMBED ? null : <Legend kinds={kindsPresent} edgeTypesPresent={graph.edgeTypesPresent} hiddenEdges={hiddenEdges} config={config} />}
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
        <div className={'toast' + (toast && /fail/i.test(toast) ? ' err' : '')}>{busy ? busy + ' in progress… (the pipeline can take a minute)' : toast}</div>
      ) : null}
    </div>
  )
}
