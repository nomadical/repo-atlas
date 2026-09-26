import { describe, expect, it } from 'vitest'
import { LAYERS } from '../graph.js'
import { filterSummary } from './filterSummary.js'

const noFacets = { group: new Set(), status: new Set(), health: new Set(), hidden: new Set() }
const defaultLayers = Object.fromEntries(LAYERS.map((layer) => [layer.key, layer.default]))
const summaryFor = (view, overrides = {}) =>
  filterSummary({
    view,
    facets: noFacets,
    layers: defaultLayers,
    hiddenEdges: new Set(),
    groupParam: null,
    ...overrides,
  })

describe('filterSummary', () => {
  it('reads default with nothing changed', () => {
    expect(summaryFor('graph')).toEqual({ filterCount: 0, isDefaultFilters: true })
  })

  it('counts hidden arrows where the view draws arrows', () => {
    for (const view of ['graph', 'integrations']) {
      expect(summaryFor(view, { hiddenEdges: new Set(['kafka']) })).toEqual({
        filterCount: 1,
        isDefaultFilters: false,
      })
    }
  })

  it('ignores hidden arrows in the badge and the reset link where there are no arrows', () => {
    for (const view of ['table', 'matrix']) {
      expect(summaryFor(view, { hiddenEdges: new Set(['kafka']) })).toEqual({
        filterCount: 0,
        isDefaultFilters: true,
      })
    }
  })
})
