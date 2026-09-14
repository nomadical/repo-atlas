import React from 'react'
import { useStore, getBezierPath, EdgeLabelRenderer, Position } from '@xyflow/react'

// --- floating-edge geometry (adapted from the React Flow floating-edges example) ---
// v12: internal nodes expose measured dimensions + an absolute position under `internals`.
const dims = (n) => ({ w: n.measured?.width || 0, h: n.measured?.height || 0 })
const absPos = (n) => n.internals?.positionAbsolute || n.position

function getNodeIntersection(intersectionNode, targetNode) {
  const { w: iw, h: ih } = dims(intersectionNode)
  const { w: tw, h: th } = dims(targetNode)
  const w = iw / 2
  const h = ih / 2
  const ip = absPos(intersectionNode)
  const tp = absPos(targetNode)
  const x2 = ip.x + w
  const y2 = ip.y + h
  const x1 = tp.x + tw / 2
  const y1 = tp.y + th / 2
  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h)
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h)
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1)
  const xx3 = a * xx1
  const yy3 = a * yy1
  return { x: w * (xx3 + yy3) + x2, y: h * (-xx3 + yy3) + y2 }
}

function getEdgePosition(node, point) {
  const p = absPos(node)
  const { w } = dims(node)
  const nx = Math.round(p.x)
  const ny = Math.round(p.y)
  const px = Math.round(point.x)
  const py = Math.round(point.y)
  if (px <= nx + 1) return Position.Left
  if (px >= nx + w - 1) return Position.Right
  if (py <= ny + 1) return Position.Top
  return Position.Bottom
}

function getEdgeParams(source, target) {
  const sp = getNodeIntersection(source, target)
  const tp = getNodeIntersection(target, source)
  return { sx: sp.x, sy: sp.y, tx: tp.x, ty: tp.y, sourcePos: getEdgePosition(source, sp), targetPos: getEdgePosition(target, tp) }
}

export function FloatingEdge({ id, source, target, markerEnd, style, label, labelStyle, data }) {
  const sourceNode = useStore((s) => s.nodeLookup.get(source))
  const targetNode = useStore((s) => s.nodeLookup.get(target))
  if (!sourceNode || !targetNode || !sourceNode.measured?.width || !targetNode.measured?.width) return null
  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(sourceNode, targetNode)
  const [path, labelX, labelY] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos,
    curvature: 0.3,
  })
  // labels render in a separate portal layer, so the .react-flow__edge.dim CSS can't reach them —
  // honor the focus state passed through edge data instead (hide when dimmed).
  return (
    <>
      {/* `fill: none` must be inline (not only via the .react-flow__edge-path CSS class): html-to-image
          doesn't carry stylesheet rules into the PNG export, so without it every bezier path fills
          solid black in the exported image. */}
      <path id={id} className="react-flow__edge-path" d={path} markerEnd={markerEnd} style={{ fill: 'none', ...style }} />
      {label && !data?.dim ? (
        <EdgeLabelRenderer>
          <div
            className="edge-label"
            title={data?.channelFull || undefined}
            style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`, ...labelStyle }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

export const edgeTypes = { floating: FloatingEdge }
