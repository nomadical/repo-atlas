import React from 'react'
import { NodeResizer } from '@xyflow/react'

// Cluster outline. The body is click-through (pointer-events:none) so cards stay interactive; the
// label is the grab handle (drag to move). For admins, a NodeResizer adds edge/corner handles when
// the region is selected, so groups can be resized. Geometry overrides persist via the layout map.
export default function RegionNode({ data, selected }) {
  return (
    <div className="region" style={{ borderColor: data.color }}>
      {data.editable ? (
        <NodeResizer
          isVisible={selected}
          minWidth={160}
          minHeight={120}
          color={data.color}
          handleClassName="region-resize-handle"
          lineClassName="region-resize-line"
          onResizeEnd={(_, p) => data.onResize?.({ x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) })}
        />
      ) : null}
      <span className="region-label" style={{ color: data.color }}>
        {data.label}
      </span>
    </div>
  )
}
