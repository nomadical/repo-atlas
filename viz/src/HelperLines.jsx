import { useEffect, useRef } from 'react'
import { useStore } from '@xyflow/react'
import { KIND } from './graph.js'

// Figma-style alignment guides for admin card dragging. getHelperLines compares the dragged card's
// edges + center against every other card and, when one lands within `distance` flow-units of an
// alignment, returns the snapped position plus the guide line(s) to draw. Adapted from the xyflow
// "helper lines" example, extended with center alignment + same-kind colouring.
const dimsOf = (n) => ({ w: n.measured?.width ?? n.width ?? 224, h: n.measured?.height ?? n.height ?? 96 })

export function getHelperLines(change, nodes, distance = 8) {
  const result = { horizontal: undefined, vertical: undefined, color: undefined, snapPosition: { x: undefined, y: undefined } }
  const nodeA = nodes.find((n) => n.id === change.id)
  if (!nodeA) return result
  const a = dimsOf(nodeA)
  const A = {
    left: change.position.x,
    right: change.position.x + a.w,
    cx: change.position.x + a.w / 2,
    top: change.position.y,
    bottom: change.position.y + a.h,
    cy: change.position.y + a.h / 2,
  }
  let vDist = distance,
    hDist = distance
  for (const nodeB of nodes) {
    if (nodeB.id === nodeA.id || nodeB.type !== 'card') continue
    const b = dimsOf(nodeB)
    const B = {
      left: nodeB.position.x,
      right: nodeB.position.x + b.w,
      cx: nodeB.position.x + b.w / 2,
      top: nodeB.position.y,
      bottom: nodeB.position.y + b.h,
      cy: nodeB.position.y + b.h / 2,
    }
    const color = KIND[nodeB.data?.kind]?.color
    // vertical guides (align on x)
    const vCandidates = [
      [Math.abs(A.left - B.left), B.left, B.left],
      [Math.abs(A.right - B.right), B.right - a.w, B.right],
      [Math.abs(A.cx - B.cx), B.cx - a.w / 2, B.cx],
    ]
    for (const [d, snapX, lineX] of vCandidates)
      if (d < vDist) {
        result.snapPosition.x = snapX
        result.vertical = lineX
        result.color = color
        vDist = d
      }
    // horizontal guides (align on y)
    const hCandidates = [
      [Math.abs(A.top - B.top), B.top, B.top],
      [Math.abs(A.bottom - B.bottom), B.bottom - a.h, B.bottom],
      [Math.abs(A.cy - B.cy), B.cy - a.h / 2, B.cy],
    ]
    for (const [d, snapY, lineY] of hCandidates)
      if (d < hDist) {
        result.snapPosition.y = snapY
        result.horizontal = lineY
        result.color = color
        hDist = d
      }
  }
  return result
}

// Canvas overlay that paints the active guide lines, mapping flow coords -> screen via the live
// viewport transform. pointer-events:none so it never intercepts drags.
export function HelperLines({ horizontal, vertical, color }) {
  const ref = useRef(null)
  const width = useStore((s) => s.width)
  const height = useStore((s) => s.height)
  const tx = useStore((s) => s.transform[0])
  const ty = useStore((s) => s.transform[1])
  const zoom = useStore((s) => s.transform[2])

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!ctx || !canvas) return
    const dpi = window.devicePixelRatio || 1
    canvas.width = width * dpi
    canvas.height = height * dpi
    ctx.scale(dpi, dpi)
    ctx.clearRect(0, 0, width, height)
    ctx.strokeStyle = color || '#ec4899'
    ctx.lineWidth = 1
    if (typeof vertical === 'number') {
      const x = vertical * zoom + tx
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()
    }
    if (typeof horizontal === 'number') {
      const y = horizontal * zoom + ty
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
    }
  }, [width, height, tx, ty, zoom, horizontal, vertical, color])

  return <canvas ref={ref} className="rf-helper-lines" style={{ width, height }} />
}
