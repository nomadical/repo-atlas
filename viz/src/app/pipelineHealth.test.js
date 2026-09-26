import { describe, expect, it } from 'vitest'
import { pipelineHealth } from './pipelineHealth.js'

const DAY = 86400000
const now = Date.parse('2026-09-26T12:00:00Z')
const noNodes = { nodes: [] }
const generatedDaysAgo = (days) => ({ generatedAt: new Date(now - days * DAY).toISOString() })

describe('pipelineHealth stale data', () => {
  it('warns when the data is older than the configured limit', () => {
    const health = pipelineHealth(generatedDaysAgo(12), noNodes, { dataStaleDays: 7, now })
    expect(health.count).toBe(1)
    expect(health.items[0].kind).toBe('Map data is out of date')
    expect(health.items[0].note).toBe('Last regenerated 12 days ago, past the 7-day limit.')
  })

  it('stays quiet on or before the limit, and without a limit or a timestamp', () => {
    expect(pipelineHealth(generatedDaysAgo(7), noNodes, { dataStaleDays: 7, now }).count).toBe(0)
    expect(pipelineHealth(generatedDaysAgo(30), noNodes, { now }).count).toBe(0)
    expect(pipelineHealth({}, noNodes, { dataStaleDays: 7, now }).count).toBe(0)
  })

  it('counts stale data alongside validation warnings', () => {
    const data = { ...generatedDaysAgo(9), validation: { staleClones: ['a', 'b'] } }
    expect(pipelineHealth(data, noNodes, { dataStaleDays: 7, now }).count).toBe(3)
  })
})
