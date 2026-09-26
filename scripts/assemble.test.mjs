// Tests for the pure rules assemble.mjs is built on. Run with `node --test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { putFirst, recordRestPair } from './lib/assemble-rules.mjs'

// ---- putFirst -------------------------------------------------------------------------

test('putFirst: the first entry wins even when a later token differs only in case', () => {
  const index = new Map()
  putFirst(index, 'Billing', 'billing-service')
  putFirst(index, 'billing', 'other')
  putFirst(index, 'BILLING', 'third')
  assert.deepEqual([...index], [['billing', 'billing-service']])
})

test('putFirst: skips empty tokens', () => {
  const index = new Map()
  putFirst(index, '', 'x')
  putFirst(index, undefined, 'x')
  assert.equal(index.size, 0)
})

// ---- recordRestPair -------------------------------------------------------------------

const derivedRow = (channel) => ({ source: 'a', target: 'b', channel, via: 'code', verified: true })

test('recordRestPair: a second config for a derived pair merges, it does not confirm', () => {
  const state = { curatedByKey: new Map(), derivedByKey: new Map() }
  const first = derivedRow('/first')
  assert.equal(recordRestPair(state, 'a>b', first), 'added')
  assert.equal(recordRestPair(state, 'a>b', derivedRow('/second')), 'merged')
  assert.equal(first.curated, undefined)
  assert.equal(first.channel, '/first')
})

test('recordRestPair: a curated CSV row is confirmed once, then merged', () => {
  const csvRow = { source: 'a', target: 'b', channel: '', verified: false }
  const state = { curatedByKey: new Map([['a>b', csvRow]]), derivedByKey: new Map() }
  assert.equal(recordRestPair(state, 'a>b', derivedRow('/first')), 'confirmed')
  assert.equal(recordRestPair(state, 'a>b', derivedRow('/second')), 'merged')
  assert.deepEqual(csvRow, {
    source: 'a',
    target: 'b',
    channel: '/first',
    verified: true,
    via: 'code',
    curated: true,
  })
})
