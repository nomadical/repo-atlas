// Tests for the bounded-concurrency pool used by azure-gather. Run with `node --test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPooled } from './lib/run-pooled.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('results keep input order when tasks finish in scrambled order', async () => {
  const delays = [30, 5, 20, 0, 15, 10, 25, 1]
  const finished = []
  const thunks = delays.map((delay, index) => async () => {
    await sleep(delay)
    finished.push(index)
    return `result-${index}`
  })
  const results = await runPooled(thunks, 3)
  assert.deepEqual(
    results,
    delays.map((_, index) => `result-${index}`),
  )
  assert.notDeepEqual(
    finished,
    [...finished].sort((a, b) => a - b),
    'the fake tasks really finish out of order',
  )
})

test('never runs more than the limit at once', async () => {
  let running = 0
  let maxRunning = 0
  const thunks = Array.from({ length: 10 }, (_, index) => async () => {
    running++
    maxRunning = Math.max(maxRunning, running)
    await sleep(index % 3)
    running--
  })
  await runPooled(thunks, 4)
  assert.equal(maxRunning, 4)
})

test('no thunks gives no results', async () => {
  assert.deepEqual(await runPooled([], 5), [])
})
