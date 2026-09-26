import React, { useMemo } from 'react'
import { useStore, getBezierPath, EdgeLabelRenderer, Position } from '@xyflow/react'
import { LABEL_FRACTIONS, edgeLabelSize, pickLabelPoint, regionLabelBox } from './edgeLabelPlacement.js'

// Floating-edge geometry, adapted from the React Flow floating-edges example.
const EDGE_CURVATURE = 0.3
// How close (in px) a point must be to a node side to count as on that side.
const SIDE_TOLERANCE = 1

// React Flow v12 internal nodes carry measured dimensions and an absolute position under `internals`.
const sizeOf = (node) => ({ width: node.measured?.width || 0, height: node.measured?.height || 0 })
const absolutePositionOf = (node) => node.internals?.positionAbsolute || node.position

// Where the line from `node`'s center towards `otherNode`'s center crosses `node`'s border.
function getNodeIntersection(node, otherNode) {
  const { width: nodeWidth, height: nodeHeight } = sizeOf(node)
  const { width: otherWidth, height: otherHeight } = sizeOf(otherNode)
  const halfWidth = nodeWidth / 2
  const halfHeight = nodeHeight / 2
  const nodePosition = absolutePositionOf(node)
  const otherPosition = absolutePositionOf(otherNode)
  const centerX = nodePosition.x + halfWidth
  const centerY = nodePosition.y + halfHeight
  const otherCenterX = otherPosition.x + otherWidth / 2
  const otherCenterY = otherPosition.y + otherHeight / 2
  // Map into a rotated unit square, scale the direction onto its border, and map back.
  const rotatedX = (otherCenterX - centerX) / (2 * halfWidth) - (otherCenterY - centerY) / (2 * halfHeight)
  const rotatedY = (otherCenterX - centerX) / (2 * halfWidth) + (otherCenterY - centerY) / (2 * halfHeight)
  const scale = 1 / (Math.abs(rotatedX) + Math.abs(rotatedY) || 1)
  const borderX = scale * rotatedX
  const borderY = scale * rotatedY
  return {
    x: halfWidth * (borderX + borderY) + centerX,
    y: halfHeight * (-borderX + borderY) + centerY,
  }
}

function getSideOfNode(node, point) {
  const position = absolutePositionOf(node)
  const { width } = sizeOf(node)
  const nodeX = Math.round(position.x)
  const nodeY = Math.round(position.y)
  const pointX = Math.round(point.x)
  const pointY = Math.round(point.y)
  if (pointX <= nodeX + SIDE_TOLERANCE) return Position.Left
  if (pointX >= nodeX + width - SIDE_TOLERANCE) return Position.Right
  if (pointY <= nodeY + SIDE_TOLERANCE) return Position.Top
  return Position.Bottom
}

function getEdgeParams(source, target) {
  const sourcePoint = getNodeIntersection(source, target)
  const targetPoint = getNodeIntersection(target, source)
  return {
    sourceX: sourcePoint.x,
    sourceY: sourcePoint.y,
    targetX: targetPoint.x,
    targetY: targetPoint.y,
    sourcePosition: getSideOfNode(source, sourcePoint),
    targetPosition: getSideOfNode(target, targetPoint),
  }
}

// One detached SVG path, reused to sample points along each edge's curve.
let samplingPath = null
function pointsAlongPath(path, fractions) {
  if (typeof document === 'undefined') return null
  samplingPath ??= document.createElementNS('http://www.w3.org/2000/svg', 'path')
  // jsdom has no SVG geometry
  if (typeof samplingPath.getTotalLength !== 'function') return null
  samplingPath.setAttribute('d', path)
  const length = samplingPath.getTotalLength()
  return fractions.map((fraction) => samplingPath.getPointAtLength(length * fraction))
}

const selectNodes = (state) => state.nodes

function regionLabelBoxes(nodes) {
  return nodes
    .filter((node) => node.type === 'region' && node.data?.label)
    .map((node) => regionLabelBox(node.position, node.data.label))
}

export function FloatingEdge({ id, source, target, markerEnd, style, label, labelStyle, data }) {
  const sourceNode = useStore((state) => state.nodeLookup.get(source))
  const targetNode = useStore((state) => state.nodeLookup.get(target))
  const nodes = useStore(selectNodes)
  const regionLabels = useMemo(() => regionLabelBoxes(nodes), [nodes])
  if (!sourceNode || !targetNode) return null
  if (!sourceNode.measured?.width || !targetNode.measured?.width) return null

  const [path, midX, midY] = getBezierPath({
    ...getEdgeParams(sourceNode, targetNode),
    curvature: EDGE_CURVATURE,
  })
  const candidates = label ? pointsAlongPath(path, LABEL_FRACTIONS) : null
  const { x: labelX, y: labelY } = candidates
    ? pickLabelPoint(candidates, edgeLabelSize(label), regionLabels)
    : { x: midX, y: midY }
  // Labels render in a separate portal, out of reach of the .react-flow__edge.dim CSS, so the
  // focus state comes through edge data instead.
  const showLabel = label && !data?.dim

  return (
    <>
      {/* `fill: none` must be inline: html-to-image doesn't carry stylesheet rules into the PNG
          export, so without it every bezier path fills solid black. */}
      <path
        id={id}
        className="react-flow__edge-path"
        d={path}
        markerEnd={markerEnd}
        style={{ fill: 'none', ...style }}
      />
      {showLabel ? (
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
