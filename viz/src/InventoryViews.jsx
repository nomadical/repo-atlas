import { useState, useMemo } from 'react'
import { StatusChip, docHref } from './ui.jsx'

// Full Component Inventory as a sortable, filterable table — the list counterpart to the graph,
// the list counterpart to the graph — so a hand-maintained inventory page can be retired.
// `externals` maps a repo basename -> its auto-detected integrations (data.repos[].externals), so the
// realistic third-party picture shows here without hand-maintaining it.
export function InventoryTable({ inventory, query, onSelect, externals = {}, docSearchUrl }) {
  const [sort, setSort] = useState({ key: 'name', dir: 1 })
  const q = query.trim().toLowerCase()
  const val = (e, k) =>
    k === 'deployed' ? e.azure?.lastPush || '' : k === 'alerts' ? (e.health?.alerts?.total ?? -1) : k === 'ci' ? e.health?.ci?.conclusion || '' : e[k] || ''
  const rows = useMemo(() => {
    let r = inventory
    if (q)
      r = r.filter((e) =>
        [e.name, e.abbr, e.type, e.status, e.owner, e.contact, e.description, (e.applications || []).join(' ')].join(' ').toLowerCase().includes(q),
      )
    return [...r].sort((a, b) => {
      const av = val(a, sort.key)
      const bv = val(b, sort.key)
      return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))) * sort.dir
    })
  }, [inventory, q, sort])
  const th = (key, label) => (
    <th className={'sortable' + (sort.key === key ? ' sorted' : '')} onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 }))}>
      {label}
      {sort.key === key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
    </th>
  )
  return (
    <div className="table-wrap">
      <div className="table-meta">
        {rows.length} of {inventory.length} components{q ? ` matching “${query}”` : ''}
      </div>
      <table className="inv-table">
        <thead>
          <tr>
            {th('name', 'Component')}
            {th('repoName', 'Repo')}
            {th('abbr', 'Abbr')}
            {th('type', 'Type')}
            {th('language', 'Stack')}
            {th('status', 'Status')}
            {th('deployed', 'Deployed')}
            {th('owner', 'Owner (team)')}
            {th('ci', 'CI')}
            {th('alerts', 'Alerts')}
            {th('contact', 'Tech contact')}
            <th>Application</th>
            <th>Documentation</th>
            <th>Integrations</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e, i) => {
            const exts = (e.repoName && externals[e.repoName]) || []
            return (
              <tr
                key={e.name + ':' + i}
                onClick={() => onSelect(e)}
                tabIndex={0}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault()
                    onSelect(e)
                  }
                }}
              >
                <td>
                  <b>{e.name}</b>
                  {e.description ? (
                    <div className="muted small">
                      {e.description.slice(0, 100)}
                      {e.description.length > 100 ? '…' : ''}
                    </div>
                  ) : null}
                </td>
                <td className="mono small">
                  {e.repo ? (
                    <a href={e.repo} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}>
                      {e.repoName}
                    </a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="mono small">{e.abbr}</td>
                <td className="small">
                  {e.type}
                  {e.subtype ? <div className="muted small">{e.subtype}</div> : null}
                </td>
                <td className="small">{[e.language, e.framework].filter(Boolean).join(' · ') || <span className="muted">—</span>}</td>
                <td>
                  <StatusChip status={e.status} />
                </td>
                <td className="small mono" title={e.azure?.image}>
                  {e.azure?.lastPush ? e.azure.lastPush.slice(0, 10) : <span className="muted">—</span>}
                </td>
                <td className="small">{e.owner}</td>
                <td className="small">
                  {e.health?.ci ? (
                    <span className={'ci-chip ci-' + (e.health.ci.conclusion || e.health.ci.status || 'unknown')}>
                      {e.health.ci.conclusion || e.health.ci.status}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="small">
                  {e.health?.alerts ? (
                    <span
                      className={e.health.alerts.total ? 'alerts-bad' : 'muted'}
                      title={
                        e.health.alerts.total
                          ? `${e.health.alerts.critical}C / ${e.health.alerts.high}H / ${e.health.alerts.medium}M / ${e.health.alerts.low}L`
                          : 'no open alerts'
                      }
                    >
                      {e.health.alerts.total}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="small">{e.contact}</td>
                <td className="small">{(e.applications || []).join(', ')}</td>
                <td className="small">
                  {(e.doc || e.docUrl) && docHref(e.doc, e.docUrl, docSearchUrl) ? (
                    <a href={docHref(e.doc, e.docUrl, docSearchUrl)} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}>
                      {e.doc || e.docUrl}
                    </a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="small">
                  {exts.length ? (
                    <div className="chiprow">
                      {exts.map((x) => (
                        <span key={x.name} className="ext-chip" title={x.via}>
                          {x.name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// Roadmap-style application columns: full inventory name -> short header, in display order. Set
// yours in config.json `applicationLabels` (an ordered {full: short} map) to give long application
// names a column-width abbreviation and to fix their left-to-right order. Applications present in
// the data but absent from the map still render — the full name doubles as its own short header
// (see MatrixView) — so this is curation, not a gate, and an empty map is fine.
const DEFAULT_APP_LABELS = {}
const appLabelsOf = (config) => {
  const m = config?.applicationLabels && Object.keys(config.applicationLabels).length ? config.applicationLabels : DEFAULT_APP_LABELS
  return Object.entries(m)
}
// Rows reflect the component Type directly (a fixed, sensible order); only types actually present
// render, and any unknown type appends after the known ones.
const TYPE_ROWS = ['Client', 'Service', 'Library', 'Tests', 'Third-Party Service', 'Infrastructure', 'Data', 'Config', 'Firmware', 'Hardware', 'Assets']
const rowOf = (type) => type || 'Other'
const MX_STATUS_MOD = { Sunsetting: 'st-sunsetting', Planned: 'st-planned', Removed: 'st-removed' }
const UNASSIGNED = '(no application)'

// Two-dimensional grouping (Application × Type), like the architecture roadmap. A component that
// serves several applications appears in each of those columns. The inventory arrives already
// narrowed by the active group/status filters (facetInventory), so this just lays it out.
export function MatrixView({ inventory, query, onSelect, config }) {
  const q = query.trim().toLowerCase()
  const items = q ? inventory.filter((e) => [e.name, e.owner, e.type, e.abbr, (e.applications || []).join(' ')].join(' ').toLowerCase().includes(q)) : inventory
  const appsOf = (e) => (e.applications && e.applications.length ? e.applications : [UNASSIGNED])
  const present = new Set(items.flatMap(appsOf))
  const appLabels = appLabelsOf(config)
  // columns: known apps (in display order) then any extra; the "no application" column shows as "—".
  const wanted = (full) => present.has(full)
  const cols = appLabels.filter(([full]) => wanted(full))
  for (const a of present) if (wanted(a) && !appLabels.some(([full]) => full === a) && a !== UNASSIGNED) cols.push([a, a])
  if (wanted(UNASSIGNED)) cols.push([UNASSIGNED, '—'])
  const rowsPresent = new Set(items.map((e) => rowOf(e.type)))
  const rows = [...TYPE_ROWS.filter((t) => rowsPresent.has(t)), ...[...rowsPresent].filter((t) => !TYPE_ROWS.includes(t)).sort()]
  const cell = (full, row) => items.filter((e) => appsOf(e).includes(full) && rowOf(e.type) === row)
  return (
    <div className="matrix-wrap">
      <div className="table-meta">
        {items.length} components · Application × Type{q ? ` · matching “${query}”` : ''}
      </div>
      <table className="matrix">
        <thead>
          <tr>
            <th className="corner" scope="col" title="Rows = Type, columns = Application">
              Type ↓ / App →
            </th>
            {cols.map(([full, short]) => (
              <th key={full} title={full}>
                {short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row}>
              <th className="matrix-layer">{row}</th>
              {cols.map(([full]) => (
                <td key={full}>
                  {cell(full, row).map((e) => (
                    <button
                      key={e.name + full}
                      className={'mx-chip ' + (MX_STATUS_MOD[e.status] || '')}
                      title={`${e.name} · ${e.status}${e.description ? '\n' + e.description : ''}`}
                      onClick={() => onSelect(e)}
                    >
                      {e.name}
                    </button>
                  ))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="matrix-legend">
        <span className="matrix-legend-label">Status</span>
        <span className="mx-chip mx-legend">Current</span>
        <span className="mx-chip mx-legend st-sunsetting">Sunsetting</span>
        <span className="mx-chip mx-legend st-planned">Planned</span>
        <span className="mx-chip mx-legend st-removed">Removed</span>
      </div>
      <div className="matrix-note">
        Columns = Application · rows = component Type · both inferred from the inventory. Header tooltips show the full application name.
      </div>
    </div>
  )
}

// All service-to-service integrations (data.integrations) as a sortable, filterable table — the list
// counterpart to the graph's Integrations / service-link layers, replacing a hand-maintained "Integrations"
// database. Source/target names that resolve to an inventory component are clickable (they open that
// component's Details via onSelect); third-party endpoints (Kafka, external APIs) render as plain text.
// Not narrowed by the group/status facets — this view is the full integration list.
export function IntegrationsTable({ integrations = [], inventory = [], query, onSelect }) {
  const [sort, setSort] = useState({ key: 'source', dir: 1 })
  const q = query.trim().toLowerCase()
  const byName = useMemo(() => {
    const m = {}
    for (const e of inventory) {
      m[e.name.toLowerCase()] = e
      if (e.repoName) m[e.repoName.toLowerCase()] = e
    }
    return m
  }, [inventory])
  const rows = useMemo(() => {
    let r = integrations
    if (q) r = r.filter((it) => [it.source, it.target, it.protocol, it.channel, it.note].join(' ').toLowerCase().includes(q))
    return [...r].sort((a, b) => String(a[sort.key] ?? '').localeCompare(String(b[sort.key] ?? '')) * sort.dir)
  }, [integrations, q, sort])
  const th = (key, label) => (
    <th className={'sortable' + (sort.key === key ? ' sorted' : '')} onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 }))}>
      {label}
      {sort.key === key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
    </th>
  )
  const endpoint = (name) => {
    const e = byName[String(name || '').toLowerCase()]
    return e ? (
      // a button, not href="#": it's an in-page action, and "#" both pollutes the URL-state
      // contract and reads as a dead link to assistive tech
      <button type="button" className="linklike" onClick={() => onSelect(e)}>
        {name}
      </button>
    ) : (
      <span>{name}</span>
    )
  }
  return (
    <div className="table-wrap">
      <div className="table-meta">
        {rows.length} of {integrations.length} integrations{q ? ` matching “${query}”` : ''}
      </div>
      <table className="inv-table">
        <thead>
          <tr>
            {th('source', 'Source')}
            {th('target', 'Target')}
            {th('protocol', 'Protocol')}
            {th('channel', 'Topic / endpoint')}
            {th('verified', 'Verified')}
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((it, i) => (
            <tr key={it.source + '→' + it.target + ':' + i}>
              <td className="small">{endpoint(it.source)}</td>
              <td className="small">{endpoint(it.target)}</td>
              <td className="small">{it.protocol ? <span className="ext-chip">{it.protocol}</span> : <span className="muted">—</span>}</td>
              <td className="small">{it.channel || <span className="muted">—</span>}</td>
              <td className="small">{it.verified ? '✓' : <span className="muted">unverified</span>}</td>
              <td className="small muted">{it.note || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
