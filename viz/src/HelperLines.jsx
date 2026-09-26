import { useEffect, useRef } from 'react'
import { useStore } from '@xyflow/react'
import { KIND } from './graph.js'

// Figma-style alignment guides for admin card dragging, adapted from the xyflow "helper lines"
// example with center alignment and same-kind colouring added.
const DEFAULT_CARD_WIDTH = 224
const DEFAULT_CARD_HEIGHT = 96
const DEFAULT_SNAP_DISTANCE = 8
const DEFAULT_LINE_COLOR = '#ec4899'

const sizeOf = (node) => ({
  width: node.measured?.width ?? node.width ?? DEFAULT_CARD_WIDTH,
  height: node.measured?.height ?? node.height ?? DEFAULT_CARD_HEIGHT,
})

function edgesOf(position, size) {
  return {
    left: position.x,
    right: position.x + size.width,
    centerX: position.x + size.width / 2,
    top: position.y,
    bottom: position.y + size.height,
    centerY: position.y + size.height / 2,
  }
}

// Compares the dragged card's edges and center against every other card. When one lands within
// `distance` flow units of an alignment, returns the snapped position plus the guide line(s) to draw.
export function getHelperLines(change, nodes, distance = DEFAULT_SNAP_DISTANCE) {
  const result = {
    horizontal: undefined,
    vertical: undefined,
    color: undefined,
    snapPosition: { x: undefined, y: undefined },
  }
  const dragged = nodes.find((node) => node.id === change.id)
  if (!dragged) return result
  const draggedSize = sizeOf(dragged)
  const a = edgesOf(change.position, draggedSize)
  let closestVertical = distance
  let closestHorizontal = distance

  for (const other of nodes) {
    if (other.id === dragged.id || other.type !== 'card') continue
    const b = edgesOf(other.position, sizeOf(other))
    const color = KIND[other.data?.kind]?.color

    // Each candidate is [distance, snapped coordinate for the dragged card, guide line coordinate].
    const verticalCandidates = [
      [Math.abs(a.left - b.left), b.left, b.left],
      [Math.abs(a.right - b.right), b.right - draggedSize.width, b.right],
      [Math.abs(a.centerX - b.centerX), b.centerX - draggedSize.width / 2, b.centerX],
    ]
    for (const [gap, snapX, lineX] of verticalCandidates) {
      if (gap < closestVertical) {
        result.snapPosition.x = snapX
        result.vertical = lineX
        result.color = color
        closestVertical = gap
      }
    }

    const horizontalCandidates = [
      [Math.abs(a.top - b.top), b.top, b.top],
      [Math.abs(a.bottom - b.bottom), b.bottom - draggedSize.height, b.bottom],
      [Math.abs(a.centerY - b.centerY), b.centerY - draggedSize.height / 2, b.centerY],
    ]
    for (const [gap, snapY, lineY] of horizontalCandidates) {
      if (gap < closestHorizontal) {
        result.snapPosition.y = snapY
        result.horizontal = lineY
        result.color = color
        closestHorizontal = gap
      }
    }
  }
  return result
}

function strokeLine(context, fromX, fromY, toX, toY) {
  context.beginPath()
  context.moveTo(fromX, fromY)
  context.lineTo(toX, toY)
  context.stroke()
}

// Canvas overlay painting the active guides, mapping flow coordinates to screen via the live
// viewport transform. pointer-events:none so it never intercepts drags.
export function HelperLines({ horizontal, vertical, color }) {
  const canvasRef = useRef(null)
  const width = useStore((state) => state.width)
  const height = useStore((state) => state.height)
  const translateX = useStore((state) => state.transform[0])
  const translateY = useStore((state) => state.transform[1])
  const zoom = useStore((state) => state.transform[2])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!context || !canvas) return
    const pixelRatio = window.devicePixelRatio || 1
    canvas.width = width * pixelRatio
    canvas.height = height * pixelRatio
    context.scale(pixelRatio, pixelRatio)
    context.clearRect(0, 0, width, height)
    context.strokeStyle = color || DEFAULT_LINE_COLOR
    context.lineWidth = 1
    if (typeof vertical === 'number') {
      const x = vertical * zoom + translateX
      strokeLine(context, x, 0, x, height)
    }
    if (typeof horizontal === 'number') {
      const y = horizontal * zoom + translateY
      strokeLine(context, 0, y, width, y)
    }
  }, [width, height, translateX, translateY, zoom, horizontal, vertical, color])

  return <canvas ref={canvasRef} className="rf-helper-lines" style={{ width, height }} />
}
