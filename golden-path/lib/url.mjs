// The view, as a link: tab, filters and the analytics window live in the query string.
// Pure — no DOM, no `location`.

export const DEFAULT_SEGMENT = 'applicable'

// State field -> parameter; a test walks state against this map, so a new filter can't quietly
// stay out of the link. `component` is the open drawer, not a filter.
export const STATE_TO_PARAM = {
  tab: 'tab',
  segments: 'segments',
  type: 'type',
  owner: 'owner',
  filter: 'show',
  q: 'search',
  group: 'group',
}

// Everything this module owns; the caller clears these before writing and leaves the rest alone.
export const PARAM_KEYS = [...Object.values(STATE_TO_PARAM), 'component', 'range', 'from', 'to']

const SHOW_URL = { dev: 'deviations', unk: 'not-scanned' }
const SHOW_STATE = { deviations: 'dev', 'not-scanned': 'unk' }
const RANGE_KEYS = ['quarter', 'year', 'custom'] // 'all' is the default and is never written
// `none` because an empty selection is real — an empty string would read as "not set".
const NO_SEGMENTS = 'none'

const listOf = (set) => [...set].sort().join(',')
const isoDay = (time) => new Date(time).toISOString().slice(0, 10)

function segmentsParam(segments) {
  const list = listOf(segments)
  if (list === DEFAULT_SEGMENT) return ''
  return list || NO_SEGMENTS
}

// Only a custom window pins dates; a named one is recomputed.
const rangeDateParam = (range, time) => (range.key === 'custom' && time ? isoDay(time) : '')

// Defaults are left out, so an untouched view stays a clean `?view=golden-path`.
export function toParams({ state, range, component = null }) {
  const params = {}
  const put = (key, value) => {
    if (value) params[key] = value
  }
  put('component', component || '')
  put('tab', state.tab === 'analytics' ? 'analytics' : '')
  put('segments', segmentsParam(state.segments))
  put('type', listOf(state.type))
  put('owner', listOf(state.owner))
  put('show', SHOW_URL[state.filter] || '')
  put('search', state.q.trim())
  put('group', state.group ? 'true' : '')
  put('range', range.key === 'all' ? '' : range.key)
  put('from', rangeDateParam(range, range.from))
  put('to', rangeDateParam(range, range.to))
  return params
}

function segmentsFrom(param) {
  if (param === NO_SEGMENTS) return new Set()
  if (!param) return new Set([DEFAULT_SEGMENT])
  return new Set(param.split(',').filter(Boolean))
}

// Links shared before the Owner filter adopted the table's "No owner" label.
const LEGACY_OWNER_LABELS = { '(no owner)': 'No owner' }
const ownerFrom = (owners) => new Set(owners.map((owner) => LEGACY_OWNER_LABELS[owner] ?? owner))

// An unparsable date reads as null, so the caller can fall back.
const dateFrom = (param) => Date.parse(param || '') || null

// The reverse. Malformed values fall back to defaults: a hand-edited link shows the page, not an error.
export function fromParams(search) {
  const params = new URLSearchParams(search)
  const listParam = (key) => (params.get(key) || '').split(',').filter(Boolean)
  const rangeKey = RANGE_KEYS.includes(params.get('range')) ? params.get('range') : 'all'
  const isCustom = rangeKey === 'custom'
  return {
    component: params.get('component') || null,
    state: {
      tab: params.get('tab') === 'analytics' ? 'analytics' : 'table',
      segments: segmentsFrom(params.get('segments')),
      type: new Set(listParam('type')),
      owner: ownerFrom(listParam('owner')),
      filter: SHOW_STATE[params.get('show')] || 'all',
      q: params.get('search') || '',
      group: params.get('group') === 'true',
    },
    range: {
      key: rangeKey,
      from: isCustom ? dateFrom(params.get('from')) : null,
      to: isCustom ? dateFrom(params.get('to')) : null,
    },
  }
}

// Fresh Sets each call — a shared one would leak selections between mounts.
export const defaultState = () => ({
  tab: 'table',
  type: new Set(),
  owner: new Set(),
  filter: 'all',
  q: '',
  group: false,
  segments: new Set([DEFAULT_SEGMENT]),
})
