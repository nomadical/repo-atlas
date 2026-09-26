import React from 'react'
import { NodeResizer } from '@xyflow/react'

const MIN_REGION_WIDTH = 160
const MIN_REGION_HEIGHT = 120

// Cluster outline. The body is click-through (pointer-events:none) so cards stay interactive; the
// label is the drag handle. Admins get resize handles while the region is selected.
export default function RegionNode({ data, selected }) {
  const reportResize = (_event, params) =>
    data.onResize?.({
      x: Math.round(params.x),
      y: Math.round(params.y),
      w: Math.round(params.width),
      h: Math.round(params.height),
    })

  return (
    <div className="region" style={{ borderColor: data.color }}>
      {data.editable ? (
        <NodeResizer
          isVisible={selected}
          minWidth={MIN_REGION_WIDTH}
          minHeight={MIN_REGION_HEIGHT}
          color={data.color}
          handleClassName="region-resize-handle"
          lineClassName="region-resize-line"
          onResizeEnd={reportResize}
        />
      ) : null}
      <span className="region-label" style={{ color: data.color }}>
        {data.label}
      </span>
    </div>
  )
}
