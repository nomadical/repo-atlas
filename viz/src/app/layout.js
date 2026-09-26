// Card-position overrides are scoped per view mode: dev and overview have different node sets, so
// a card arranged in one shouldn't displace the other.
export const EMPTY_LAYOUT = { dev: {}, overview: {} }

export const UNDO_LIMIT = 50

// Same padding the auto-layout uses (graph.js `box`), with extra top room for the region label.
const REGION_SIDE_PADDING = 34
const REGION_TOP_PADDING = 52
const REGION_BOTTOM_PADDING = 30
const DEFAULT_CARD_WIDTH = 224
const DEFAULT_CARD_HEIGHT = 96

// Older configs stored a flat {id: {x, y}} map; treat that as the dev layout.
export function normalizeLayout(layout) {
  if (!layout || typeof layout !== 'object') return { ...EMPTY_LAYOUT }
  if (layout.dev || layout.overview) return { dev: layout.dev || {}, overview: layout.overview || {} }
  return { dev: layout, overview: {} }
}

export const withOverride = (layout, mode, id, override) => ({
  ...layout,
  [mode]: { ...layout[mode], [id]: override },
})

export function withoutOverride(layout, mode, id) {
  const modeLayout = { ...layout[mode] }
  delete modeLayout[id]
  return { ...layout, [mode]: modeLayout }
}

export const roundedPosition = (node) => ({ x: Math.round(node.position.x), y: Math.round(node.position.y) })

const cardWidth = (node) => node.measured?.width ?? node.width ?? DEFAULT_CARD_WIDTH
const cardHeight = (node) => node.measured?.height ?? node.height ?? DEFAULT_CARD_HEIGHT

// The region box that tightly wraps the given cards (live positions + measured sizes).
export function regionBoundsAround(cards) {
  const minX = Math.min(...cards.map((card) => card.position.x)) - REGION_SIDE_PADDING
  const maxX = Math.max(...cards.map((card) => card.position.x + cardWidth(card))) + REGION_SIDE_PADDING
  const minY = Math.min(...cards.map((card) => card.position.y)) - REGION_TOP_PADDING
  const maxY = Math.max(...cards.map((card) => card.position.y + cardHeight(card))) + REGION_BOTTOM_PADDING
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    w: Math.round(maxX - minX),
    h: Math.round(maxY - minY),
  }
}
