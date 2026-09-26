import { expect, it, vi } from 'vitest'
import { revealNode } from './viewport.js'

// A flow at zoom 1 with no pan: flow coordinates are screen coordinates.
function fakeFlow(node) {
  return {
    getInternalNode: () => node,
    flowToScreenPosition: (point) => point,
    getZoom: () => 1,
    setCenter: vi.fn(),
  }
}

const card = (x, y) => ({ internals: { positionAbsolute: { x, y } }, measured: { width: 200, height: 100 } })
const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 700, bottom: 800 }) }

it('leaves a node that is already visible where it is', () => {
  const flow = fakeFlow(card(100, 100))
  expect(revealNode(flow, 'a', canvas, 0)).toBe(false)
  expect(flow.setCenter).not.toHaveBeenCalled()
})

it('centres a node the details panel has pushed off the canvas, keeping the zoom', () => {
  const flow = fakeFlow(card(900, 100))
  expect(revealNode(flow, 'a', canvas, 0)).toBe(true)
  expect(flow.setCenter).toHaveBeenCalledWith(1000, 150, { zoom: 1, duration: 0 })
})
