import { LAYERS } from '../graph.js'

// Layers exist only in the graph; the arrows section only in the graph and Integrations views.
// Filters a view has no control for count in neither the badge nor the reset link, or the two
// would disagree with each other and with what the menu shows.
const ARROW_VIEWS = new Set(['graph', 'integrations'])

// The Filters badge counts what's switched on or away from its default, so clearing reads 0.
// Clearing every group is a deviation too (groupParam is then '').
export function filterSummary({ view, facets, layers, hiddenEdges, groupParam }) {
  const layerDeviations =
    view === 'graph' ? LAYERS.filter((layer) => layers[layer.key] !== layer.default).length : 0
  const hiddenArrows = ARROW_VIEWS.has(view) ? hiddenEdges.size : 0
  const filterCount =
    facets.group.size +
    facets.status.size +
    facets.health.size +
    facets.hidden.size +
    layerDeviations +
    hiddenArrows
  const isDefaultFilters =
    groupParam == null &&
    !facets.status.size &&
    !facets.health.size &&
    !facets.hidden.size &&
    !layerDeviations &&
    !hiddenArrows
  return { filterCount, isDefaultFilters }
}
