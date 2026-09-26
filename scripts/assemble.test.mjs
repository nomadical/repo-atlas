// Tests for the pure rules assemble.mjs is built on. Run with `node --test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { putFirst } from './lib/assemble-rules.mjs'

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
