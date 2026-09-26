import { describe, expect, it } from 'vitest'
import { edgeLabelSize, pickLabelPoint, regionLabelBox } from './edgeLabelPlacement.js'

describe('edge label placement', () => {
  const region = regionLabelBox({ x: 100, y: 200 }, 'Environment')
  const size = edgeLabelSize('2.9.4 ⚠')

  it('puts the region label box over the top-left of the region border', () => {
    expect(region.x).toBeLessThan(114)
    expect(region.y).toBeLessThan(188)
    expect(region.y + region.height).toBeGreaterThan(200)
    expect(region.x + region.width).toBeGreaterThan(114 + 'Environment'.length * 7)
  })

  it('keeps the midpoint when nothing is in the way', () => {
    const candidates = [
      { x: 0, y: 0 },
      { x: 50, y: 50 },
    ]
    expect(pickLabelPoint(candidates, size, [region])).toBe(candidates[0])
  })

  it('slides off a region label that the midpoint would cover', () => {
    const onTheName = { x: 150, y: 200 }
    const clearOfIt = { x: 150, y: 260 }
    expect(pickLabelPoint([onTheName, clearOfIt], size, [region])).toBe(clearOfIt)
  })

  it('falls back to the midpoint when every candidate is covered', () => {
    const candidates = [
      { x: 150, y: 200 },
      { x: 160, y: 200 },
    ]
    expect(pickLabelPoint(candidates, size, [region])).toBe(candidates[0])
  })
})
