// Keeps edge labels off the cluster name pills. A label sits at its curve's midpoint unless that
// would cover a region label; then it slides along the curve to the nearest clear spot.

// Fractions along the curve to try, nearest to the midpoint first.
export const LABEL_FRACTIONS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]

// Sizes in flow px, estimated from the text so placement needs no DOM measurement. They mirror
// .region-label (11px bold uppercase, 0.6px tracking, 10px side padding, top: -12px, left: 14px)
// and .edge-label (10px bold, 5px side padding).
const REGION_LABEL = { left: 14, top: -12, height: 19, charWidth: 7.6, padding: 22 }
const EDGE_LABEL = { height: 15, charWidth: 6.2, padding: 12 }
// Breathing room kept between an edge label and a region label.
const CLEARANCE = 4

export function regionLabelBox(position, label) {
  return {
    x: position.x + REGION_LABEL.left - CLEARANCE,
    y: position.y + REGION_LABEL.top - CLEARANCE,
    width: String(label).length * REGION_LABEL.charWidth + REGION_LABEL.padding + 2 * CLEARANCE,
    height: REGION_LABEL.height + 2 * CLEARANCE,
  }
}

export function edgeLabelSize(text) {
  return { width: String(text).length * EDGE_LABEL.charWidth + EDGE_LABEL.padding, height: EDGE_LABEL.height }
}

const overlaps = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

// The first candidate point whose centred label box clears every obstacle. If none does, the first
// candidate (the midpoint) wins: a covered name beats a label far from its edge.
export function pickLabelPoint(candidates, size, obstacles) {
  if (!obstacles.length) return candidates[0]
  const boxAt = (point) => ({
    x: point.x - size.width / 2,
    y: point.y - size.height / 2,
    width: size.width,
    height: size.height,
  })
  const clear = candidates.find((point) => !obstacles.some((obstacle) => overlaps(boxAt(point), obstacle)))
  return clear || candidates[0]
}
