const ACTIVATION_KEYS = new Set(['Enter', ' '])

// The id of the map node a key press activates: Enter or Space on the focused node itself, not on a
// control inside it.
export function activatedNodeId(event) {
  if (!ACTIVATION_KEYS.has(event.key)) return null
  const target = event.target
  if (!target?.classList?.contains('react-flow__node')) return null
  return target.dataset.id || null
}
