import { Handle, Position } from '@xyflow/react'
import { KIND } from './graph.js'
import { Icon } from './icons.jsx'

const STATUS_MOD = { Sunsetting: 'st-sunsetting', Planned: 'st-planned', Removed: 'st-removed' }

export default function CardNode({ data, selected }) {
  const k = KIND[data.kind] || { color: '#888', label: data.kind }
  const statusMod = data.status && STATUS_MOD[data.status]
  // Compose a single "what am I looking at?" tooltip for the whole card, labelling each structured
  // field (Christian's request: it wasn't clear what the coloured title, grey tags, three-letter
  // code, etc. mean). Per-element titles below name each piece; this summarises them in one place.
  const inv = data.repo?.inventory || data.inventory
  const cardTip = [
    `Component type: ${k.label}`,
    data.status ? `Lifecycle status: ${data.status}` : '',
    inv?.owner ? `Group (team): ${inv.owner}` : '',
    inv?.abbr ? `Abbreviation: ${inv.abbr}` : '',
    inv?.applications?.length ? `Application(s): ${inv.applications.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <div className={'node-card' + (selected ? ' selected' : '') + (statusMod ? ' ' + statusMod : '')} style={{ borderTopColor: k.color }} title={cardTip}>
      <Handle type="target" position={Position.Left} className="hidden-handle" />
      <Handle type="source" position={Position.Right} className="hidden-handle" />
      {data.status && data.status !== 'Current' ? (
        <span className={'node-status ' + statusMod} title={`Lifecycle status: ${data.status}`}>
          {data.status}
        </span>
      ) : null}
      {data.tags?.length ? (
        <div className="node-tags" title="Application / product tags">
          {data.tags.map((t) => (
            <span key={t.label} className="tag" style={{ background: t.color }} title={`Application: ${t.label}`}>
              {t.label}
            </span>
          ))}
        </div>
      ) : null}
      <div className="node-kind" style={{ color: k.color }} title={`Component type: ${k.label}`}>
        {k.label}
        {data.stale ? (
          <span className="node-stale" title={`No commits in ${data.staleDays} days`}>
            <Icon name="dot" /> stale
          </span>
        ) : null}
        {/* One curation badge: both "new" and "curate" mean "metadata still missing", so show a
            single flag — "curate" when half-curated, else "new" for a brand-new uncurated repo. */}
        {data.flags?.incomplete ? (
          <span className="node-flag warn" title="Incomplete curation — missing owner / status / description">
            curate
          </span>
        ) : data.flags?.isNew ? (
          <span className="node-flag new" title="Newly discovered — not yet curated">
            new
          </span>
        ) : null}
        {(() => {
          // at-a-glance repo health: flag only when there's a problem (high/critical alerts or non-green CI)
          const h = data.repo?.inventory?.health || data.inventory?.health
          if (!h) return null
          const bad = (h.alerts?.critical || 0) + (h.alerts?.high || 0)
          const ciBad = h.ci?.conclusion && h.ci.conclusion !== 'success'
          if (!bad && !ciBad) return null
          const label = bad ? `${bad} alert${bad > 1 ? 's' : ''}` : 'CI'
          return (
            <span
              className="node-flag health-flag"
              title={`${bad ? `${bad} high/critical Dependabot alerts` : ''}${bad && ciBad ? ' · ' : ''}${ciBad ? `CI ${h.ci.conclusion}` : ''}`}
            >
              {label}
            </span>
          )
        })()}
      </div>
      <div className="node-title" title="Component name">
        {String(data.title)
          .split('\n')
          .map((l, i) => (
            <div key={i}>{l}</div>
          ))}
      </div>
      {data.subtitle ? (
        <div className="node-sub" title={inv?.abbr || inv?.owner ? 'Group (team) · abbreviation' : 'Repository / description'}>
          {data.subtitle}
        </div>
      ) : null}
      {data.chips?.length ? (
        <div className="node-chips">
          {data.chips.map((c) => (
            <span key={c} className="chip">
              {c}
            </span>
          ))}
        </div>
      ) : null}
      {data.repo?.externals?.length ? (
        <div className="node-ext" title={data.repo.externals.map((e) => e.name).join(', ')}>
          <Icon name="integrations" /> {data.repo.externals.length} integrations
        </div>
      ) : null}
    </div>
  )
}
