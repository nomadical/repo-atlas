import { useState, useMemo } from 'react'
import { StatusChip, docHref } from './ui.jsx'

const DESCRIPTION_PREVIEW_LENGTH = 100
// Sorts components without alert data below those with zero alerts.
const NO_ALERT_DATA = -1

const toggledSort = (key) => (sort) => ({ key, dir: sort.key === key ? -sort.dir : 1 })

function SortableHeader({ sortKey, label, sort, setSort }) {
  const isSorted = sort.key === sortKey
  return (
    <th className={'sortable' + (isSorted ? ' sorted' : '')} onClick={() => setSort(toggledSort(sortKey))}>
      {label}
      {isSorted ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
    </th>
  )
}

const matchesQuery = (fields, query) => fields.join(' ').toLowerCase().includes(query)

const Dash = () => <span className="muted">—</span>

const stopPropagation = (event) => event.stopPropagation()

function inventorySortValue(entry, key) {
  if (key === 'deployed') return entry.azure?.lastPush || ''
  if (key === 'alerts') return entry.health?.alerts?.total ?? NO_ALERT_DATA
  if (key === 'ci') return entry.health?.ci?.conclusion || ''
  return entry[key] || ''
}

function compareSortValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

function inventorySearchFields(entry) {
  return [
    entry.name,
    entry.abbr,
    entry.type,
    entry.status,
    entry.owner,
    entry.contact,
    entry.description,
    (entry.applications || []).join(' '),
  ]
}

function alertBreakdown(alerts) {
  return `${alerts.critical}C / ${alerts.high}H / ${alerts.medium}M / ${alerts.low}L`
}

function InventoryRow({ entry, externalsOfRepo, docSearchUrl, onSelect }) {
  const onKeyDown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onSelect(entry)
  }
  const ci = entry.health?.ci
  const alerts = entry.health?.alerts
  const documentationUrl = entry.doc || entry.docUrl ? docHref(entry.doc, entry.docUrl, docSearchUrl) : null
  return (
    <tr onClick={() => onSelect(entry)} tabIndex={0} onKeyDown={onKeyDown}>
      <td>
        <b>{entry.name}</b>
        {entry.description ? (
          <div className="muted small">
            {entry.description.slice(0, DESCRIPTION_PREVIEW_LENGTH)}
            {entry.description.length > DESCRIPTION_PREVIEW_LENGTH ? '…' : ''}
          </div>
        ) : null}
      </td>
      <td className="mono small">
        {entry.repo ? (
          <a href={entry.repo} target="_blank" rel="noreferrer" onClick={stopPropagation}>
            {entry.repoName}
          </a>
        ) : (
          <Dash />
        )}
      </td>
      <td className="mono small">{entry.abbr}</td>
      <td className="small">
        {entry.type}
        {entry.subtype ? <div className="muted small">{entry.subtype}</div> : null}
      </td>
      <td className="small">{[entry.language, entry.framework].filter(Boolean).join(' · ') || <Dash />}</td>
      <td>
        <StatusChip status={entry.status} />
      </td>
      <td className="small mono" title={entry.azure?.image}>
        {entry.azure?.lastPush ? entry.azure.lastPush.slice(0, 10) : <Dash />}
      </td>
      <td className="small">{entry.owner}</td>
      <td className="small">
        {ci ? (
          <span className={'ci-chip ci-' + (ci.conclusion || ci.status || 'unknown')}>
            {ci.conclusion || ci.status}
          </span>
        ) : (
          <Dash />
        )}
      </td>
      <td className="small">
        {alerts ? (
          <span
            className={alerts.total ? 'alerts-bad' : 'muted'}
            title={alerts.total ? alertBreakdown(alerts) : 'no open alerts'}
          >
            {alerts.total}
          </span>
        ) : (
          <Dash />
        )}
      </td>
      <td className="small">{entry.contact}</td>
      <td className="small">{(entry.applications || []).join(', ')}</td>
      <td className="small">
        {documentationUrl ? (
          <a href={documentationUrl} target="_blank" rel="noreferrer" onClick={stopPropagation}>
            {entry.doc || entry.docUrl}
          </a>
        ) : (
          <Dash />
        )}
      </td>
      <td className="small">
        {externalsOfRepo.length ? (
          <div className="chiprow">
            {externalsOfRepo.map((external) => (
              <span key={external.name} className="ext-chip" title={external.via}>
                {external.name}
              </span>
            ))}
          </div>
        ) : (
          <Dash />
        )}
      </td>
    </tr>
  )
}

// The full Component Inventory as a sortable, filterable table: the list counterpart to the graph.
// `externals` maps a repo name to its auto-detected integrations.
export function InventoryTable({ inventory, query, onSelect, externals = {}, docSearchUrl }) {
  const [sort, setSort] = useState({ key: 'name', dir: 1 })
  const normalizedQuery = query.trim().toLowerCase()
  const rows = useMemo(() => {
    const matching = normalizedQuery
      ? inventory.filter((entry) => matchesQuery(inventorySearchFields(entry), normalizedQuery))
      : inventory
    return [...matching].sort(
      (a, b) =>
        compareSortValues(inventorySortValue(a, sort.key), inventorySortValue(b, sort.key)) * sort.dir,
    )
  }, [inventory, normalizedQuery, sort])
  const header = (key, label) => <SortableHeader sortKey={key} label={label} sort={sort} setSort={setSort} />
  return (
    <div className="table-wrap">
      <div className="table-meta">
        {rows.length} of {inventory.length} components{normalizedQuery ? ` matching “${query}”` : ''}
      </div>
      <table className="inv-table">
        <thead>
          <tr>
            {header('name', 'Component')}
            {header('repoName', 'Repo')}
            {header('abbr', 'Abbr')}
            {header('type', 'Type')}
            {header('language', 'Stack')}
            {header('status', 'Status')}
            {header('deployed', 'Deployed')}
            {header('owner', 'Owner (team)')}
            {header('ci', 'CI')}
            {header('alerts', 'Alerts')}
            {header('contact', 'Tech contact')}
            <th>Application</th>
            <th>Documentation</th>
            <th>Integrations</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((entry, index) => (
            <InventoryRow
              key={entry.name + ':' + index}
              entry={entry}
              externalsOfRepo={(entry.repoName && externals[entry.repoName]) || []}
              docSearchUrl={docSearchUrl}
              onSelect={onSelect}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

// config.json `applicationLabels` is an ordered { full name: short header } map that sets the
// matrix column order and abbreviations. Applications missing from it still get a column, headed by
// their full name, so an empty map is fine.
const DEFAULT_APP_LABELS = {}
function appLabelsOf(config) {
  const hasLabels = config?.applicationLabels && Object.keys(config.applicationLabels).length
  return Object.entries(hasLabels ? config.applicationLabels : DEFAULT_APP_LABELS)
}

// Fixed row order; only types present render, and unknown types append after these.
const TYPE_ROWS = [
  'Client',
  'Service',
  'Library',
  'Tests',
  'Third-Party Service',
  'Infrastructure',
  'Data',
  'Config',
  'Firmware',
  'Hardware',
  'Assets',
]
const rowOf = (type) => type || 'Other'
const MATRIX_STATUS_CLASS = { Sunsetting: 'st-sunsetting', Planned: 'st-planned', Removed: 'st-removed' }
const UNASSIGNED = '(no application)'
const UNASSIGNED_HEADER = '—'

const applicationsOf = (entry) =>
  entry.applications && entry.applications.length ? entry.applications : [UNASSIGNED]

// [full name, header] pairs: labelled apps in their configured order, then unlabelled apps, then the
// "no application" column.
function matrixColumns(presentApps, appLabels) {
  const columns = appLabels.filter(([full]) => presentApps.has(full))
  for (const app of presentApps) {
    const isLabelled = appLabels.some(([full]) => full === app)
    if (!isLabelled && app !== UNASSIGNED) columns.push([app, app])
  }
  if (presentApps.has(UNASSIGNED)) columns.push([UNASSIGNED, UNASSIGNED_HEADER])
  return columns
}

function matrixRows(items) {
  const presentTypes = new Set(items.map((entry) => rowOf(entry.type)))
  const knownTypes = TYPE_ROWS.filter((type) => presentTypes.has(type))
  const unknownTypes = [...presentTypes].filter((type) => !TYPE_ROWS.includes(type)).sort()
  return [...knownTypes, ...unknownTypes]
}

// Application × Type grid, like the architecture roadmap. A component serving several applications
// appears in each of their columns. The inventory arrives already narrowed by the group/status filters.
export function MatrixView({ inventory, query, onSelect, config }) {
  const normalizedQuery = query.trim().toLowerCase()
  const items = normalizedQuery
    ? inventory.filter((entry) =>
        matchesQuery(
          [entry.name, entry.owner, entry.type, entry.abbr, (entry.applications || []).join(' ')],
          normalizedQuery,
        ),
      )
    : inventory
  const columns = matrixColumns(new Set(items.flatMap(applicationsOf)), appLabelsOf(config))
  const rows = matrixRows(items)
  const itemsInCell = (app, row) =>
    items.filter((entry) => applicationsOf(entry).includes(app) && rowOf(entry.type) === row)
  return (
    <div className="matrix-wrap">
      <div className="table-meta">
        {items.length} components · Application × Type{normalizedQuery ? ` · matching “${query}”` : ''}
      </div>
      <table className="matrix">
        <thead>
          <tr>
            <th className="corner" scope="col" title="Rows = Type, columns = Application">
              Type ↓ / App →
            </th>
            {columns.map(([full, header]) => (
              <th key={full} title={full}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row}>
              <th className="matrix-layer">{row}</th>
              {columns.map(([full]) => (
                <td key={full}>
                  {itemsInCell(full, row).map((entry) => (
                    <button
                      key={entry.name + full}
                      className={'mx-chip ' + (MATRIX_STATUS_CLASS[entry.status] || '')}
                      title={`${entry.name} · ${entry.status}${entry.description ? '\n' + entry.description : ''}`}
                      onClick={() => onSelect(entry)}
                    >
                      {entry.name}
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
        Columns = Application · rows = component Type · both inferred from the inventory. Header tooltips show
        the full application name.
      </div>
    </div>
  )
}

// Indexed by lowercased name and repo name.
function indexInventoryByName(inventory) {
  const byName = new Map()
  for (const entry of inventory) {
    byName.set(entry.name.toLowerCase(), entry)
    if (entry.repoName) byName.set(entry.repoName.toLowerCase(), entry)
  }
  return byName
}

// Every service-to-service integration as a sortable, filterable table. Endpoints that resolve to an
// inventory component open its Details; third-party ends (Kafka, external APIs) are plain text.
// Deliberately not narrowed by the group/status filters.
export function IntegrationsTable({ integrations = [], inventory = [], query, onSelect }) {
  const [sort, setSort] = useState({ key: 'source', dir: 1 })
  const normalizedQuery = query.trim().toLowerCase()
  const byName = useMemo(() => indexInventoryByName(inventory), [inventory])
  const rows = useMemo(() => {
    const matching = normalizedQuery
      ? integrations.filter((integration) =>
          matchesQuery(
            [
              integration.source,
              integration.target,
              integration.protocol,
              integration.channel,
              integration.note,
            ],
            normalizedQuery,
          ),
        )
      : integrations
    return [...matching].sort(
      (a, b) => String(a[sort.key] ?? '').localeCompare(String(b[sort.key] ?? '')) * sort.dir,
    )
  }, [integrations, normalizedQuery, sort])
  const header = (key, label) => <SortableHeader sortKey={key} label={label} sort={sort} setSort={setSort} />
  const endpoint = (name) => {
    const entry = byName.get(String(name || '').toLowerCase())
    if (!entry) return <span>{name}</span>
    // A button, not href="#": it's an in-page action, and "#" would pollute the URL state and read
    // as a dead link to assistive tech.
    return (
      <button type="button" className="linklike" onClick={() => onSelect(entry)}>
        {name}
      </button>
    )
  }
  return (
    <div className="table-wrap">
      <div className="table-meta">
        {rows.length} of {integrations.length} integrations{normalizedQuery ? ` matching “${query}”` : ''}
      </div>
      <table className="inv-table">
        <thead>
          <tr>
            {header('source', 'Source')}
            {header('target', 'Target')}
            {header('protocol', 'Protocol')}
            {header('channel', 'Topic / endpoint')}
            {header('verified', 'Verified')}
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((integration, index) => (
            <tr key={integration.source + '→' + integration.target + ':' + index}>
              <td className="small">{endpoint(integration.source)}</td>
              <td className="small">{endpoint(integration.target)}</td>
              <td className="small">
                {integration.protocol ? <span className="ext-chip">{integration.protocol}</span> : <Dash />}
              </td>
              <td className="small">{integration.channel || <Dash />}</td>
              <td className="small">
                {integration.verified ? '✓' : <span className="muted">unverified</span>}
              </td>
              <td className="small muted">{integration.note || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
