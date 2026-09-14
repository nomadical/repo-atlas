/* The view survives being turned into a link and back. This is the whole risk of putting state in
   the URL: nothing throws when it breaks, links just quietly stop carrying what they used to, and
   the person who notices is whoever the link was sent to. Run with `node --test`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toParams, fromParams, defaultState, STATE_TO_PARAM, PARAM_KEYS, DEFAULT_SEGMENT } from '../lib/url.mjs'

const qs = (params) => new URLSearchParams(params).toString()
// A state with nothing left at its default, so the round trip has something to lose on every field.
const loaded = () => ({
  tab: 'analytics',
  type: new Set(['Service', 'Client']),
  owner: new Set(['Platform']),
  filter: 'unk',
  q: 'sky',
  group: true,
  segments: new Set(['archived', 'excluded']),
})
const custom = { key: 'custom', from: Date.parse('2026-07-01'), to: Date.parse('2026-08-11') }

test('every field of the state is carried by a parameter', () => {
  /* The one test that catches the mistake nobody would notice: a filter added to the screen and
     wired to the controls, but never serialised. It works perfectly until somebody shares it. */
  for (const key of Object.keys(defaultState())) {
    assert.ok(STATE_TO_PARAM[key], `state.${key} has no URL parameter — add it to STATE_TO_PARAM (and to toParams/fromParams)`)
  }
  for (const param of Object.values(STATE_TO_PARAM)) {
    assert.ok(PARAM_KEYS.includes(param), `${param} is missing from PARAM_KEYS, so switching it off would leave it in the address bar`)
  }
})

test('a fully loaded view round-trips unchanged', () => {
  const state = loaded()
  const back = fromParams(qs(toParams({ state, range: custom, component: 'skycore-backend' })))
  assert.deepEqual(back.state, state, 'every filter came back as it went in')
  assert.equal(back.component, 'skycore-backend')
  assert.equal(back.range.key, 'custom')
  assert.equal(back.range.from, custom.from, 'the custom window kept its start')
  assert.equal(back.range.to, custom.to, 'and its end')
})

test('defaults are never written, so the plain view has a clean URL', () => {
  const params = toParams({ state: defaultState(), range: { key: 'all', from: 1, to: 2 } })
  assert.deepEqual(params, {}, `nothing should be written for the default view, got ${JSON.stringify(params)}`)
  // ...and reading nothing back gives the default view again.
  assert.deepEqual(fromParams('').state, defaultState())
})

test('an empty segment selection survives, instead of reverting to the default', () => {
  /* The reader unticked every group and the table is deliberately empty. An empty list in the URL
     would be indistinguishable from "not set", and the default would silently come back. */
  const state = { ...defaultState(), segments: new Set() }
  const params = toParams({ state, range: { key: 'all' } })
  assert.equal(params.segments, 'none')
  assert.deepEqual([...fromParams(qs(params)).state.segments], [], 'still empty after the round trip')
})

test('the default segment is not written, and comes back on its own', () => {
  const params = toParams({ state: defaultState(), range: { key: 'all' } })
  assert.equal(params.segments, undefined, 'the default selection is not worth a parameter')
  assert.deepEqual([...fromParams('').state.segments], [DEFAULT_SEGMENT])
})

test('a named analytics window carries no dates', () => {
  /* Deliberate: the edges are recomputed from the history, so a link to "Quarter" is still a
     quarter next month rather than frozen to the day it was sent. */
  for (const key of ['quarter', 'year']) {
    const params = toParams({ state: defaultState(), range: { key, from: 111, to: 222 } })
    assert.equal(params.range, key)
    assert.equal(params.from, undefined, `${key} should not pin a start date`)
    assert.equal(params.to, undefined, `${key} should not pin an end date`)
    const back = fromParams(qs(params)).range
    assert.equal(back.key, key)
    assert.equal(back.from, null, 'the caller recomputes a named window from the history')
  }
})

test('the state filters read as words in the link', () => {
  const url = (filter) => toParams({ state: { ...defaultState(), filter }, range: { key: 'all' } }).show
  assert.equal(url('dev'), 'deviations')
  assert.equal(url('unk'), 'not-scanned')
  assert.equal(url('all'), undefined, 'the default filter is not written')
  assert.equal(fromParams('show=deviations').state.filter, 'dev')
  assert.equal(fromParams('show=not-scanned').state.filter, 'unk')
})

test('a hand-edited link degrades to the default view rather than breaking', () => {
  const cases = ['show=nonsense', 'range=nonsense', 'tab=nonsense', 'group=yes', 'range=custom&from=notadate&to=alsonot', 'type=&owner=']
  for (const search of cases) {
    const back = fromParams(search)
    assert.equal(back.state.filter, 'all', `${search}: unknown filter falls back to all`)
    assert.equal(back.state.tab, back.state.tab === 'analytics' ? 'analytics' : 'table', `${search}: tab is one of the two`)
    assert.ok(back.range.key === 'all' || back.range.key === 'custom', `${search}: range is a known key`)
    if (search.includes('notadate')) {
      assert.equal(back.range.from, null, 'an unparsable date reads as absent, so the caller can fall back')
      assert.equal(back.range.to, null)
    }
    if (search.includes('group=yes')) assert.equal(back.state.group, false, 'only the exact word turns it on')
  }
})

test('lists are order-independent, so the same view is always the same link', () => {
  const a = toParams({ state: { ...defaultState(), type: new Set(['Client', 'Service']) }, range: { key: 'all' } })
  const b = toParams({ state: { ...defaultState(), type: new Set(['Service', 'Client']) }, range: { key: 'all' } })
  assert.equal(a.type, b.type, 'two readers who picked the same types should produce the same URL')
})

test('defaultState hands out fresh sets', () => {
  // A shared Set would leak one reader's selection into the next mount of the screen.
  const a = defaultState()
  a.type.add('Service')
  assert.deepEqual([...defaultState().type], [], 'a new state must not carry the previous one’s selection')
})
