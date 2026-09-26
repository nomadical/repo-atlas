// Viewport helpers for the map canvas.

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

// How long a pan/zoom animates: instant for viewers who asked for reduced motion.
export function motionDuration(duration) {
  const reduced = typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION).matches
  return reduced ? 0 : duration
}

// Runs `callback` once the browser has laid out the current commit (two frames: React Flow learns
// the canvas's new size from a ResizeObserver after the first). Returns a cancel function.
export function afterLayout(callback) {
  let cancelled = false
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!cancelled) callback()
    }),
  )
  return () => {
    cancelled = true
  }
}

export const isRectInside = (inner, outer) =>
  inner.left >= outer.left &&
  inner.top >= outer.top &&
  inner.right <= outer.right &&
  inner.bottom <= outer.bottom

// The node's on-screen rectangle, from its flow position and measured size.
export function nodeScreenRect(flow, node) {
  const { x, y } = node.internals.positionAbsolute
  const width = node.measured?.width ?? 0
  const height = node.measured?.height ?? 0
  const topLeft = flow.flowToScreenPosition({ x, y })
  const bottomRight = flow.flowToScreenPosition({ x: x + width, y: y + height })
  return { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y }
}

// Pans (at the current zoom) so the node is centred, unless it's already fully inside `canvas`.
export function revealNode(flow, id, canvas, duration) {
  const node = flow?.getInternalNode(id)
  if (!node || !canvas) return false
  if (isRectInside(nodeScreenRect(flow, node), canvas.getBoundingClientRect())) return false
  const { x, y } = node.internals.positionAbsolute
  const centerX = x + (node.measured?.width ?? 0) / 2
  const centerY = y + (node.measured?.height ?? 0) / 2
  flow.setCenter(centerX, centerY, { zoom: flow.getZoom(), duration: motionDuration(duration) })
  return true
}
