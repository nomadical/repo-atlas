import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import { KIND } from './graph.js'
import { Icon } from './icons.jsx'

const STATUS_CLASS = { Sunsetting: 'st-sunsetting', Planned: 'st-planned', Removed: 'st-removed' }
const UNKNOWN_KIND_COLOR = '#888'

// One tooltip for the whole card that labels each field, because the coloured title, grey tags and
// short code weren't self-explanatory.
function cardTooltip(kind, status, inventory) {
  return [
    `Component type: ${kind.label}`,
    status ? `Lifecycle status: ${status}` : '',
    inventory?.owner ? `Group (team): ${inventory.owner}` : '',
    inventory?.abbr ? `Abbreviation: ${inventory.abbr}` : '',
    inventory?.applications?.length ? `Application(s): ${inventory.applications.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

const integrationCount = (count) => `${count} integration${count === 1 ? '' : 's'}`

// Both "new" and "curate" mean "metadata still missing", so show a single flag.
function CurationFlag({ flags }) {
  if (flags?.incomplete) {
    return (
      <span className="node-flag warn" title="Incomplete curation — missing owner / status / description">
        curate
      </span>
    )
  }
  if (flags?.isNew) {
    return (
      <span className="node-flag new" title="Newly discovered — not yet curated">
        new
      </span>
    )
  }
  return null
}

// Flags repo health only when there's a problem: high/critical alerts or non-green CI.
function HealthFlag({ health }) {
  if (!health) return null
  const alertCount = (health.alerts?.critical || 0) + (health.alerts?.high || 0)
  const ciFailing = health.ci?.conclusion && health.ci.conclusion !== 'success'
  if (!alertCount && !ciFailing) return null
  const label = alertCount ? `${alertCount} alert${alertCount > 1 ? 's' : ''}` : 'CI'
  const alertText = alertCount ? `${alertCount} high/critical Dependabot alerts` : ''
  const separator = alertCount && ciFailing ? ' · ' : ''
  const ciText = ciFailing ? `CI ${health.ci.conclusion}` : ''
  return (
    <span className="node-flag health-flag" title={`${alertText}${separator}${ciText}`}>
      {label}
    </span>
  )
}

// Memoised: hover re-renders the canvas, but a card only changes when its data or selection does.
function CardNode({ data, selected }) {
  const kind = KIND[data.kind] || { color: UNKNOWN_KIND_COLOR, label: data.kind }
  const statusClass = data.status && STATUS_CLASS[data.status]
  const inventory = data.repo?.inventory || data.inventory
  const health = data.repo?.inventory?.health || data.inventory?.health
  const titleLines = String(data.title).split('\n')

  return (
    <div
      className={'node-card' + (selected ? ' selected' : '') + (statusClass ? ' ' + statusClass : '')}
      style={{ borderTopColor: kind.color }}
      title={cardTooltip(kind, data.status, inventory)}
    >
      <Handle type="target" position={Position.Left} className="hidden-handle" />
      <Handle type="source" position={Position.Right} className="hidden-handle" />
      {data.status && data.status !== 'Current' ? (
        <span className={'node-status ' + statusClass} title={`Lifecycle status: ${data.status}`}>
          {data.status}
        </span>
      ) : null}
      {data.tags?.length ? (
        <div className="node-tags" title="Application / product tags">
          {data.tags.map((tag) => (
            <span
              key={tag.label}
              className="tag"
              style={{ background: tag.color }}
              title={`Application: ${tag.label}`}
            >
              {tag.label}
            </span>
          ))}
        </div>
      ) : null}
      <div className="node-kind" style={{ color: kind.color }} title={`Component type: ${kind.label}`}>
        {kind.label}
        {data.stale ? (
          <span className="node-stale" title={`No commits in ${data.staleDays} days`}>
            <Icon name="dot" /> stale
          </span>
        ) : null}
        <CurationFlag flags={data.flags} />
        <HealthFlag health={health} />
      </div>
      <div className="node-title" title="Component name">
        {titleLines.map((line, index) => (
          <div key={index}>{line}</div>
        ))}
      </div>
      {data.subtitle ? (
        <div
          className="node-sub"
          title={
            inventory?.abbr || inventory?.owner ? 'Group (team) · abbreviation' : 'Repository / description'
          }
        >
          {data.subtitle}
        </div>
      ) : null}
      {data.chips?.length ? (
        <div className="node-chips">
          {data.chips.map((chip) => (
            <span key={chip} className="chip">
              {chip}
            </span>
          ))}
        </div>
      ) : null}
      {data.repo?.externals?.length ? (
        <div className="node-ext" title={data.repo.externals.map((external) => external.name).join(', ')}>
          <Icon name="integrations" /> {integrationCount(data.repo.externals.length)}
        </div>
      ) : null}
    </div>
  )
}

export default memo(CardNode)
