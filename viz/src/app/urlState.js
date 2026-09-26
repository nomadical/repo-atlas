// The shareable view state lives in the URL query. Every value serializes as its deviation from
// the default, so a default view keeps a clean URL and a default-on layer switched off survives a
// reload. Legacy `be=1&dpl=1` links parse identically.
import { LAYERS } from '../graph.js'

export const VIEW_LABELS = { graph: 'Graph', matrix: 'Matrix', table: 'Table', integrations: 'Integrations' }
// The one view whitelist: the URL codec, applyViewParams and the Admin default-view select all use it.
export const VIEWS = Object.keys(VIEW_LABELS)
export const GROUP_BY_LABELS = { team: 'By team', application: 'By application', platform: 'By platform' }
export const AT_RISK = 'at-risk'

const SMALL_SCREEN_WIDTH = 760

export const initialParams = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')

// Embed (kiosk) mode: the page is framed in a wiki via ?embed=1, so the toolbar shrinks to a title
// and an "open full map" link. The rest of the URL already defines which slice is shown.
export const EMBED = initialParams.get('embed') === '1'

export function readFlag(params, key, fallback) {
  if (!params.has(key)) return fallback
  return params.get(key) === '1'
}

// A present key with an empty value (`?group=`) means "show all", which is how a cleared facet
// survives a reload. An absent key returns null so the caller can apply its default.
export function readList(params, key) {
  if (!params.has(key)) return null
  return (params.get(key) || '').split(',').filter(Boolean)
}

export const initialFlag = (key, fallback) => readFlag(initialParams, key, fallback)
export const initialString = (key, fallback) => initialParams.get(key) ?? fallback

export const toView = (value) => (VIEWS.includes(value) ? value : 'graph')
export const toMode = (value) => (value === 'overview' ? 'overview' : 'dev')
export const toGroupBy = (value) => (value === 'application' || value === 'platform' ? value : 'team')

export const isSmallScreen = () => typeof window !== 'undefined' && window.innerWidth < SMALL_SCREEN_WIDTH

// Groups shown before any toggle: the clusters flagged `defaultOn` (so ISS/IoT start hidden).
export const defaultOnLabels = (clusterDefs) => clusterDefs.filter((c) => c.defaultOn).map((c) => c.label)

// Small screens default to the touch-friendly Table unless the URL pins a view. Embeds skip that,
// or a narrow iframe would flip a framed graph to the table.
export function initialView() {
  if (!initialParams.has('view')) return isSmallScreen() && !EMBED ? 'table' : 'graph'
  return toView(initialParams.get('view'))
}

export function layersFromParams(params) {
  return Object.fromEntries(LAYERS.map((layer) => [layer.key, readFlag(params, layer.param, layer.default)]))
}

// Facets: `group` = team cluster, `status` = lifecycle stage, `health` = at-risk, `hidden` = per-
// component hide list keyed by lowercased inventory name. An empty Set imposes no constraint.
export function facetsFromParams(params, defaultGroups) {
  const hidden = readList(params, 'hide') ?? []
  return {
    group: new Set(readList(params, 'group') ?? defaultGroups),
    status: new Set(readList(params, 'status') ?? []),
    health: new Set(readFlag(params, 'risk', false) ? [AT_RISK] : []),
    hidden: new Set(hidden.map((name) => name.toLowerCase())),
  }
}

export const hiddenEdgesFromParams = (params) => new Set(readList(params, 'hedge') ?? [])

// Returns null when the groups match the default-on set, so the param is left out.
export function groupParamFor(groups, defaultGroups) {
  const current = [...groups].sort()
  const defaults = [...defaultGroups].sort()
  const isDefault = current.length === defaults.length && current.every((label, i) => label === defaults[i])
  return isDefault ? null : current.join(',')
}

// Catalog cards and the Kafka bus are selectable too, so their node ids are written as well
// (matchSelNode resolves those by exact id).
function selectionParam(sel) {
  if (sel?.repo?.folder || sel?.resource?.id)
    return sel.repo?.serviceId || sel.repo?.folder || sel.resource.id
  if (sel?.inventory?.name) return 'inv:' + sel.inventory.name
  if (sel?.kind === 'bus') return 'bus:kafka'
  return null
}

const joinSet = (set) => [...set].join(',')

export function serializeViewParams(state) {
  const { layers, facets, hiddenEdges, groupParam, dark, viewMode, view, groupBy, clientId, sel, defaults } =
    state
  const params = new URLSearchParams()
  for (const layer of LAYERS) {
    if (layers[layer.key] !== layer.default) params.set(layer.param, layers[layer.key] ? '1' : '0')
  }
  if (facets.health.size) params.set('risk', '1')
  if (dark !== defaults.dark) params.set('dark', dark ? '1' : '0')
  if (groupParam != null) params.set('group', groupParam)
  if (facets.status.size) params.set('status', joinSet(facets.status))
  if (facets.hidden.size) params.set('hide', joinSet(facets.hidden))
  if (hiddenEdges.size) params.set('hedge', joinSet(hiddenEdges))
  if (viewMode !== defaults.mode) params.set('mode', viewMode)
  if (view !== defaults.view) params.set('view', view)
  if (groupBy !== 'team') params.set('by', groupBy)
  if (clientId) params.set('client', clientId)
  const selection = selectionParam(sel)
  if (selection) params.set('sel', selection)
  // stay in kiosk mode across in-iframe reloads
  if (EMBED) params.set('embed', '1')
  return params
}

// Parses a saved/shared query with the same rules as the initial URL seed, so a saved view
// round-trips exactly. Omitted params fall back to the config defaults it was serialized against.
export function parseViewParams(query, { clusterDefs, defaults }) {
  const params = new URLSearchParams(query)
  return {
    layers: layersFromParams(params),
    facets: facetsFromParams(params, defaultOnLabels(clusterDefs)),
    hiddenEdges: hiddenEdgesFromParams(params),
    dark: readFlag(params, 'dark', defaults.dark),
    mode: params.has('mode') ? toMode(params.get('mode')) : defaults.mode,
    view: toView(params.get('view') || defaults.view),
    groupBy: toGroupBy(params.get('by')),
    clientId: params.get('client') || null,
    selId: params.get('sel'),
  }
}

export function embedUrl() {
  const params = new URLSearchParams(location.search)
  params.set('embed', '1')
  return location.origin + location.pathname + '?' + params.toString()
}

export function fullMapUrl() {
  const params = new URLSearchParams(location.search)
  params.delete('embed')
  const query = params.toString()
  return location.origin + location.pathname + (query ? '?' + query : '')
}
