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

const listOf = (set) => [...set].sort().join(',')
const iso = (t) => new Date(t).toISOString().slice(0, 10)

// Defaults are left out, so an untouched view stays a clean `?view=golden-path`.
export function toParams({ state, range, component = null }) {
  const out = {}
  const put = (k, v) => {
    if (v) out[k] = v
  }
  put('component', component || '')
  put('tab', state.tab === 'analytics' ? 'analytics' : '')
  const segments = listOf(state.segments)
  // `none` because an empty selection is real — an empty string would read as "not set".
  put('segments', segments === DEFAULT_SEGMENT ? '' : segments || 'none')
  put('type', listOf(state.type))
  put('owner', listOf(state.owner))
  put('show', SHOW_URL[state.filter] || '')
  put('search', state.q.trim())
  put('group', state.group ? 'true' : '')
  put('range', range.key === 'all' ? '' : range.key)
  // Only a custom window pins dates; a named one is recomputed.
  put('from', range.key === 'custom' && range.from ? iso(range.from) : '')
  put('to', range.key === 'custom' && range.to ? iso(range.to) : '')
  return out
}

// The reverse. Malformed values fall back to defaults: a hand-edited link shows the page, not an error.
export function fromParams(search) {
  const p = new URLSearchParams(search)
  const list = (k) => (p.get(k) || '').split(',').filter(Boolean)
  const segments = p.get('segments')
  const key = RANGE_KEYS.includes(p.get('range')) ? p.get('range') : 'all'
  return {
    component: p.get('component') || null,
    state: {
      tab: p.get('tab') === 'analytics' ? 'analytics' : 'table',
      segments: new Set(segments === 'none' ? [] : segments ? segments.split(',').filter(Boolean) : [DEFAULT_SEGMENT]),
      type: new Set(list('type')),
      owner: new Set(list('owner')),
      filter: SHOW_STATE[p.get('show')] || 'all',
      q: p.get('search') || '',
      group: p.get('group') === 'true',
    },
    range: {
      key,
      from: key === 'custom' ? Date.parse(p.get('from') || '') || null : null,
      to: key === 'custom' ? Date.parse(p.get('to') || '') || null : null,
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
