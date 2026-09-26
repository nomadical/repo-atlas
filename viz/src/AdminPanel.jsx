import { useEffect, useMemo, useState } from 'react'
import { Icon } from './icons.jsx'
import { resolveClusters, STRUCTURAL_REGIONS } from './graph.js'

// Edits the curated parts of the model that the pipeline can't derive: backend topology, FE→BE
// wiring, integrations.csv edges, service↔repo overrides and inventory-extra.json fallbacks.
//
// The files stay git-committed. Under `npm run dev` the panel reads them via /api/curation and
// writes them via /api/save-curation. Read-only deploys have no server, so the panel seeds from
// the loaded data and offers copy/download of the edited files instead.

const DEV = import.meta.env.DEV
const DEFAULT_TITLE = 'Architecture Map'
const ERROR_DETAIL_LENGTH = 200
const NEW_SAAS_OPTION = '__new__'
const KAFKA_BUS = 'Kafka'
const CSV_HEADER = 'Source,Target,Protocol,Channel,Note'
const CSV_NEEDS_QUOTING = /[",\n\r]/
const VERIFY_MARKER = /verify/i
const VERIFY_SUFFIX = /\s*[—-]?\s*VERIFY/gi
// Fields stored under an inventory-extra entry's `fallback` rather than on the entry itself.
const FALLBACK_FIELDS = ['owner', 'status', 'description']
const EMPTY_INVENTORY_EXTRA = { repoExtras: {}, nonRepo: [] }
const DEFAULT_SERVICE_MAP_COMMENT =
  'Service<->repo identity map (#16). Default is identity; only overrides listed. Keys are the inventory service name; repo = owning repo folder (or null for repo-less).'

const clone = (value) => JSON.parse(JSON.stringify(value ?? null))
const uniqueSorted = (values) => [...new Set(values)].sort()
const uniqueTruthy = (values) => [...new Set(values.filter(Boolean))]

// backend-extra.json keys the panel edits; every other key passes through a save untouched.
const BACKEND_EDITED_KEYS = ['_comment', 'backends', 'feBe', 'backendExternals', 'assetConsumers']
function uneditedBackendKeys(backendExtra) {
  const entries = Object.entries(backendExtra || {}).filter(([key]) => !BACKEND_EDITED_KEYS.includes(key))
  return clone(Object.fromEntries(entries))
}

function csvCell(value) {
  const text = String(value ?? '')
  if (!CSV_NEEDS_QUOTING.test(text)) return text
  return '"' + text.replace(/"/g, '""') + '"'
}

function rowsToCsv(rows) {
  const lines = rows.map((row) =>
    [row.source, row.target, row.protocol || 'REST', row.channel || '', row.note || '']
      .map(csvCell)
      .join(','),
  )
  return [CSV_HEADER, ...lines].join('\n') + '\n'
}

const isVerified = (note) => !VERIFY_MARKER.test(note || '')

// Verified rows drop the VERIFY marker from their note; unverified rows get one appended.
function noteWithVerified(note, verified) {
  if (verified) return (note || '').replace(VERIFY_SUFFIX, '').trim()
  if (VERIFY_MARKER.test(note || '')) return note
  return (note ? note + ' — ' : '') + 'VERIFY'
}

// Curated integration rows in the shape the panel edits. A curated row that code confirmed has
// both via:'code' and curated:true; it must stay, or saving would delete every confirmed row.
function seedRows(integrations) {
  return (integrations || [])
    .filter((row) => row.curated || row.via !== 'code')
    .map((row) => ({
      source: row.source,
      target: row.target,
      protocol: row.protocol || 'REST',
      channel: row.channel || '',
      note: row.note || '',
    }))
}

function configForm(config) {
  return {
    title: config?.title || '',
    subtitle: config?.subtitle || '',
    logoUrl: config?.logoUrl || '',
    defaultView: config?.defaultView || '',
    defaultMode: config?.defaultMode || '',
    defaultTheme: config?.defaultTheme || '',
    staleDays: config?.staleDays ?? '',
  }
}

function serviceRowsFrom(services) {
  return Object.entries(services || {}).map(([name, entry]) => ({ name, repo: entry?.repo ?? '' }))
}

// An empty repo becomes null: a repo-less service.
function serviceMapFile(serviceRows, existingComment) {
  const namedRows = serviceRows.filter((row) => row.name.trim())
  return {
    $comment: existingComment || DEFAULT_SERVICE_MAP_COMMENT,
    services: Object.fromEntries(
      namedRows.map((row) => [row.name.trim(), { repo: row.repo.trim() || null }]),
    ),
  }
}

function countLayoutPositions(layout) {
  return Object.values(layout || {}).reduce(
    (total, positions) => total + Object.keys(positions || {}).length,
    0,
  )
}

function nonEmptyRegionNotes(regionNotes) {
  const notes = {}
  for (const [label, note] of Object.entries(regionNotes || {})) {
    if (note && note.trim()) notes[label] = note.trim()
  }
  return notes
}

// Blank fields are dropped so an unset option falls back to the app's built-in default. The dragged
// card layout rides along, so a curated layout publishes too.
function publishedConfig({ baseConfig, form, layout, layoutCount, regionNotes }) {
  const staleDays = Number(form.staleDays)
  const config = {
    ...baseConfig,
    title: form.title.trim() || undefined,
    subtitle: form.subtitle.trim() || undefined,
    logoUrl: form.logoUrl.trim() || undefined,
    defaultView: form.defaultView || undefined,
    defaultMode: form.defaultMode || undefined,
    defaultTheme: form.defaultTheme || undefined,
    staleDays: Number.isFinite(staleDays) && staleDays > 0 ? staleDays : undefined,
    layout: layoutCount ? layout : undefined,
    regionNotes: Object.keys(regionNotes).length ? regionNotes : undefined,
  }
  for (const key of Object.keys(config)) {
    if (config[key] === undefined) delete config[key]
  }
  return config
}

// Returns a copy of `map` with `list` under `key`, or without `key` when the list is empty.
function withListOrWithout(map, key, list) {
  const next = { ...map }
  if (list.length) next[key] = list
  else delete next[key]
  return next
}

function withGapField(inventoryExtra, repo, field, value) {
  const next = clone(inventoryExtra) || { repoExtras: {}, nonRepo: [] }
  next.repoExtras = next.repoExtras || {}
  next.repoExtras[repo] = next.repoExtras[repo] || {}
  const entry = next.repoExtras[repo]
  let target = entry
  if (FALLBACK_FIELDS.includes(field)) {
    entry.fallback = entry.fallback || {}
    target = entry.fallback
  }
  if (value) target[field] = value
  else delete target[field]
  return next
}

function gapValue(inventoryExtra, repo, field) {
  const entry = inventoryExtra?.repoExtras?.[repo] || {}
  if (FALLBACK_FIELDS.includes(field)) return entry.fallback?.[field] ?? ''
  return entry[field] ?? ''
}

// "Half-curated" entries read "<repo> — <what's missing>".
function reposWithInventoryGaps(validation) {
  const partial = (validation.incompleteCuration || []).map((line) => String(line).split(' — ')[0])
  return uniqueSorted([...(validation.uncuratedRepos || []), ...partial])
}

function download(name, text, type = 'application/json') {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([text], { type }))
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}

const toJson = (value) => JSON.stringify(value, null, 2)

const replaceAt = (list, index, patch) => list.map((item, i) => (i === index ? { ...item, ...patch } : item))
const removeAt = (list, index) => list.filter((_, i) => i !== index)

function Tab({ id, tab, setTab, children }) {
  return (
    <button className={'adm-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
      {children}
    </button>
  )
}

export default function AdminPanel({ data, layout, onResetLayout, onClose, onSaved }) {
  const [tab, setTab] = useState('settings')
  const [comment, setComment] = useState('')
  const [cfg, setCfg] = useState(() => configForm(data.config))
  const setCfgField = (field, value) => setCfg((form) => ({ ...form, [field]: value }))
  const [backends, setBackends] = useState(() => clone(data.backendTopology?.backends) || [])
  const [feBe, setFeBe] = useState(() => clone(data.backendTopology?.feBe) || {})
  const [externals, setExternals] = useState(() => clone(data.backendTopology?.backendExternals) || {})
  const [assetConsumers, setAssetConsumers] = useState(
    () => clone(data.backendTopology?.assetConsumers) || [],
  )
  const [backendRest, setBackendRest] = useState(() => uneditedBackendKeys(data.backendTopology))
  // Code-derived integrations regenerate on every pipeline run, so only curated rows are editable.
  const [rows, setRows] = useState(() => seedRows(data.integrations))
  // Baselines of the seeded values, so hand-edited fields can be highlighted. feBe and externals
  // re-seed from /api/curation in dev; rows only seed from props, so theirs never changes.
  const [baseRows] = useState(() => seedRows(data.integrations))
  const [baseFeBe, setBaseFeBe] = useState(() => clone(data.backendTopology?.feBe) || {})
  const [baseExternals, setBaseExternals] = useState(
    () => clone(data.backendTopology?.backendExternals) || {},
  )
  const codeDerivedCount = useMemo(
    () => (data.integrations || []).filter((row) => row.via === 'code').length,
    [data],
  )
  const [regionNotes, setRegionNotes] = useState(() => clone(data.config?.regionNotes) || {})
  // Team clusters from the config taxonomy plus the fixed structural bands, so a fork's own
  // clusters show up too.
  const regionLabels = useMemo(
    () => [...resolveClusters(data.config).map((cluster) => cluster.label), ...STRUCTURAL_REGIONS],
    [data.config],
  )
  const [invExtra, setInvExtra] = useState(() => clone(data.inventoryExtra))
  const [svcRows, setSvcRows] = useState(() => serviceRowsFrom(data.serviceMap?.services))
  const setSvcRow = (index, patch) => setSvcRows((current) => replaceAt(current, index, patch))
  const addSvcRow = () => setSvcRows((current) => [...current, { name: '', repo: '' }])
  const removeSvcRow = (index) => setSvcRows((current) => removeAt(current, index))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(
    DEV ? null : 'Read-only deploy — edits can be copied/downloaded, then committed to the repo.',
  )

  // In dev, prefer the raw committed files: they keep the _comment and the full
  // inventory-extra.json, which the served data merges away. On failure, keep the seeded data.
  useEffect(() => {
    if (!DEV) return
    let alive = true
    const applyBackendExtra = (backendExtra) => {
      setComment(backendExtra._comment || '')
      if (backendExtra.backends) setBackends(backendExtra.backends)
      if (backendExtra.feBe) {
        setFeBe(backendExtra.feBe)
        setBaseFeBe(clone(backendExtra.feBe))
      }
      if (backendExtra.backendExternals) {
        setExternals(backendExtra.backendExternals)
        setBaseExternals(clone(backendExtra.backendExternals))
      }
      if (backendExtra.assetConsumers) setAssetConsumers(backendExtra.assetConsumers)
      setBackendRest(uneditedBackendKeys(backendExtra))
    }
    const applyCuration = (curation) => {
      if (!alive || !curation) return
      if (curation.backendExtra) applyBackendExtra(curation.backendExtra)
      if (curation.inventoryExtra) setInvExtra(curation.inventoryExtra)
      if (curation.serviceMap?.services) setSvcRows(serviceRowsFrom(curation.serviceMap.services))
      if (curation.config) {
        setCfg(configForm(curation.config))
        if (curation.config.regionNotes) setRegionNotes(curation.config.regionNotes)
      }
    }
    fetch('/api/curation')
      .then((response) => (response.ok ? response.json() : null))
      .then(applyCuration)
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const beIds = useMemo(() => backends.map((backend) => backend.id).filter(Boolean), [backends])
  const clients = useMemo(
    () =>
      (data.repos || [])
        .filter((repo) => repo.kind === 'client')
        .map((repo) => repo.folder)
        .sort(),
    [data],
  )
  const saasNames = useMemo(() => uniqueSorted(Object.values(externals).flat()), [externals])
  // Everything an integration target can be, so the field is a pure pick-list.
  const targetNames = useMemo(
    () =>
      uniqueSorted(
        [...beIds, ...saasNames, KAFKA_BUS, ...(data.inventory || []).map((entry) => entry.name)].filter(
          Boolean,
        ),
      ),
    [beIds, saasNames, data],
  )
  const repoFolders = useMemo(() => (data.repos || []).map((repo) => repo.folder).sort(), [data])
  const svcNames = useMemo(() => (data.inventory || []).map((entry) => entry.name).sort(), [data])
  const serviceMapOut = useMemo(() => serviceMapFile(svcRows, data.serviceMap?.$comment), [svcRows, data])
  // Backend ids that wiring still references but that no longer exist, so a rename can't silently
  // orphan an edge.
  const orphanRefs = useMemo(() => {
    const referenced = new Set([...Object.values(feBe).flat(), ...Object.keys(externals)])
    return [...referenced].filter((id) => id && !beIds.includes(id))
  }, [feBe, externals, beIds])

  const backendExtra = useMemo(
    () => ({
      ...(comment ? { _comment: comment } : {}),
      backends,
      feBe,
      backendExternals: externals,
      assetConsumers: assetConsumers,
      ...backendRest,
    }),
    [comment, backends, feBe, externals, assetConsumers, backendRest],
  )
  const csv = useMemo(() => rowsToCsv(rows), [rows])
  const layoutCount = countLayoutPositions(layout)
  const cleanRegionNotes = useMemo(() => nonEmptyRegionNotes(regionNotes), [regionNotes])
  const config = useMemo(
    () =>
      publishedConfig({
        baseConfig: data.config,
        form: cfg,
        layout,
        layoutCount,
        regionNotes: cleanRegionNotes,
      }),
    [data, cfg, layout, layoutCount, cleanRegionNotes],
  )

  const toggleFeBe = (client, backendId) =>
    setFeBe((wiring) => {
      const connected = new Set(wiring[client] || [])
      if (connected.has(backendId)) connected.delete(backendId)
      else connected.add(backendId)
      return withListOrWithout(wiring, client, [...connected])
    })
  const toggleAssetConsumer = (client) =>
    setAssetConsumers((consumers) =>
      consumers.includes(client)
        ? consumers.filter((consumer) => consumer !== client)
        : [...consumers, client],
    )
  // Names are de-duplicated per backend; removing the last one drops the backend key.
  const addExternal = (backendId, name) =>
    setExternals((byBackend) => {
      const trimmed = (name || '').trim()
      if (!trimmed || (byBackend[backendId] || []).includes(trimmed)) return byBackend
      return { ...byBackend, [backendId]: [...(byBackend[backendId] || []), trimmed] }
    })
  const removeExternal = (backendId, index) =>
    setExternals((byBackend) =>
      withListOrWithout(byBackend, backendId, removeAt(byBackend[backendId] || [], index)),
    )
  // Backend ids whose "new SaaS name" text field is open.
  const [saasAdding, setSaasAdding] = useState({})
  const setSaasAddingFor = (backendId, adding) => setSaasAdding((open) => ({ ...open, [backendId]: adding }))

  const setRow = (index, patch) => setRows((current) => replaceAt(current, index, patch))
  const setRowVerified = (index, verified) =>
    setRow(index, { note: noteWithVerified(rows[index].note, verified) })
  const addRow = () =>
    setRows((current) => [...current, { source: '', target: '', protocol: 'REST', channel: '', note: '' }])
  const removeRow = (index) => setRows((current) => removeAt(current, index))
  const rowChanged = (index, field) => (baseRows[index]?.[field] ?? '') !== (rows[index]?.[field] ?? '')
  const feBeChanged = (client, backendId) =>
    (baseFeBe[client] || []).includes(backendId) !== (feBe[client] || []).includes(backendId)
  const extChanged = (backendId) =>
    (baseExternals[backendId] || []).join(', ') !== (externals[backendId] || []).join(', ')

  const gapRepos = useMemo(() => reposWithInventoryGaps(data.validation || {}), [data])
  const invByName = useMemo(
    () => Object.fromEntries((data.inventory || []).map((entry) => [entry.repoName || entry.name, entry])),
    [data],
  )
  const setGap = (repo, field, value) => setInvExtra((current) => withGapField(current, repo, field, value))
  const gapVal = (repo, field) => gapValue(invExtra, repo, field)

  // Documentation links aren't edited here: they are the repo's `doc-url` / `doc-label` custom
  // properties on GitHub (see docs/repo-maintenance.md).
  const invExtraJson = useMemo(() => toJson(invExtra ?? EMPTY_INVENTORY_EXTRA) + '\n', [invExtra])

  const copy = (text, message) => navigator.clipboard?.writeText(text).then(() => setMsg(message))

  async function save() {
    setBusy(true)
    setMsg(null)
    try {
      const body = { backendExtra, integrationsCsv: csv, config, serviceMap: serviceMapOut }
      if (invExtra) body.inventoryExtra = invExtra
      const response = await fetch('/api/save-curation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok || result.ok === false) throw new Error(JSON.stringify(result))
      setMsg(
        `Saved ${result.written.join(', ')}. Run “Regenerate data” to apply, or it lands on the next nightly.`,
      )
      onSaved?.()
    } catch (error) {
      setMsg(
        'Save failed (is the dev server running?) — ' +
          String(error.message || error).slice(0, ERROR_DETAIL_LENGTH),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="legend-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Admin — curation editor"
    >
      <div className="legend-card adm-card" onClick={(event) => event.stopPropagation()}>
        <div className="legend-head">
          <h3>Admin · curate the model</h3>
          <button className="btn ghost" onClick={onClose} aria-label="Close admin">
            <Icon name="close" />
          </button>
        </div>

        <div className="adm-tabs">
          <Tab tab={tab} setTab={setTab} id="settings">
            Settings
          </Tab>
          <Tab tab={tab} setTab={setTab} id="wiring">
            FE→BE wiring
          </Tab>
          <Tab tab={tab} setTab={setTab} id="saas">
            External SaaS ({beIds.length})
          </Tab>
          <Tab tab={tab} setTab={setTab} id="services">
            Services ({svcRows.length})
          </Tab>
          <Tab tab={tab} setTab={setTab} id="integrations">
            Integrations ({rows.length})
          </Tab>
          <Tab tab={tab} setTab={setTab} id="inventory">
            Inventory gaps ({gapRepos.length})
          </Tab>
        </div>

        {orphanRefs.length ? (
          <div className="adm-warn">
            <Icon name="warning" /> wiring references undefined backend ids: {orphanRefs.join(', ')}
          </div>
        ) : null}

        <div className="adm-body">
          {tab === 'settings' ? (
            <SettingsTab
              cfg={cfg}
              setCfgField={setCfgField}
              layoutCount={layoutCount}
              onResetLayout={onResetLayout}
              regionLabels={regionLabels}
              regionNotes={regionNotes}
              setRegionNotes={setRegionNotes}
              config={config}
              copy={copy}
            />
          ) : null}

          {tab === 'wiring' ? (
            <WiringTab
              clients={clients}
              beIds={beIds}
              feBe={feBe}
              feBeChanged={feBeChanged}
              toggleFeBe={toggleFeBe}
              assetConsumers={assetConsumers}
              toggleAssetConsumer={toggleAssetConsumer}
            />
          ) : null}

          {tab === 'saas' ? (
            <SaasTab
              beIds={beIds}
              externals={externals}
              extChanged={extChanged}
              saasNames={saasNames}
              saasAdding={saasAdding}
              setSaasAddingFor={setSaasAddingFor}
              addExternal={addExternal}
              removeExternal={removeExternal}
            />
          ) : null}

          {tab === 'services' ? (
            <ServicesTab
              svcRows={svcRows}
              setSvcRow={setSvcRow}
              addSvcRow={addSvcRow}
              removeSvcRow={removeSvcRow}
              repoFolders={repoFolders}
              svcNames={svcNames}
            />
          ) : null}

          {tab === 'integrations' ? (
            <IntegrationsTab
              rows={rows}
              codeDerivedCount={codeDerivedCount}
              beIds={beIds}
              targetNames={targetNames}
              saasNames={saasNames}
              rowChanged={rowChanged}
              setRow={setRow}
              setRowVerified={setRowVerified}
              addRow={addRow}
              removeRow={removeRow}
            />
          ) : null}

          {tab === 'inventory' ? (
            <InventoryTab
              gapRepos={gapRepos}
              invByName={invByName}
              invExtra={invExtra}
              gapVal={gapVal}
              setGap={setGap}
            />
          ) : null}
        </div>

        <div className="adm-foot">
          {msg ? (
            <span className={'adm-msg' + (/fail/i.test(msg) ? ' err' : '')}>{msg}</span>
          ) : (
            <span className="adm-msg muted">
              Source of truth is git-committed; changes apply on regenerate / nightly.
            </span>
          )}
          <div className="adm-foot-btns">
            <button
              className="btn ghost"
              onClick={() => copy(toJson(backendExtra), 'Copied backend-extra.json')}
            >
              Copy backend JSON
            </button>
            <button
              className="btn ghost"
              onClick={() => download('backend-extra.json', toJson(backendExtra))}
            >
              <Icon name="download" /> backend
            </button>
            <button className="btn ghost" onClick={() => copy(csv, 'Copied integrations.csv')}>
              Copy CSV
            </button>
            <button className="btn ghost" onClick={() => download('integrations.csv', csv, 'text/csv')}>
              <Icon name="download" /> CSV
            </button>
            {tab === 'inventory' ? (
              <>
                <button
                  className="btn ghost"
                  onClick={() => copy(invExtraJson, 'Copied inventory-extra.json')}
                >
                  Copy inventory JSON
                </button>
                <button className="btn ghost" onClick={() => download('inventory-extra.json', invExtraJson)}>
                  <Icon name="download" /> inventory
                </button>
              </>
            ) : null}
            {DEV ? (
              <button className="btn primary" disabled={busy} onClick={save}>
                {busy ? 'Saving…' : 'Save to disk'}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function TextField({ label, value, onChange, placeholder, className = 'adm-in adm-wide' }) {
  return (
    <label className="adm-field">
      <span>{label}</span>
      <input
        className={className}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  )
}

function SelectField({ label, value, onChange, options }) {
  return (
    <label className="adm-field">
      <span>{label}</span>
      <select className="adm-in" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  )
}

const VIEW_OPTIONS = [
  ['', 'Built-in (Graph)'],
  ['graph', 'Graph'],
  ['matrix', 'Matrix'],
  ['table', 'Table'],
  ['integrations', 'Integrations'],
]
const MODE_OPTIONS = [
  ['', 'Built-in (Dev)'],
  ['dev', 'Dev'],
  ['overview', 'Overview'],
]
const THEME_OPTIONS = [
  ['', 'Built-in (Light)'],
  ['light', 'Light'],
  ['dark', 'Dark'],
]

function SettingsTab({
  cfg,
  setCfgField,
  layoutCount,
  onResetLayout,
  regionLabels,
  regionNotes,
  setRegionNotes,
  config,
  copy,
}) {
  const layoutSummary = layoutCount
    ? `${layoutCount} custom card position${layoutCount === 1 ? '' : 's'}`
    : 'No custom positions — using auto-layout'
  return (
    <>
      <p className="adm-hint">
        App-wide appearance & defaults (config.json). Applies for everyone after you save and
        {DEV ? ' hit “Regenerate data” / publish' : ' republish'} (or on the next nightly). Leave a field
        blank to use the built-in default.
      </p>
      <h4 className="adm-sub">Branding</h4>
      <TextField
        label="Page title"
        value={cfg.title}
        onChange={(value) => setCfgField('title', value)}
        placeholder={DEFAULT_TITLE}
      />
      <TextField
        label="Subtitle"
        value={cfg.subtitle}
        onChange={(value) => setCfgField('subtitle', value)}
        placeholder="optional tagline shown next to the title"
      />
      <TextField
        label="Logo URL"
        className="adm-in adm-wide mono"
        value={cfg.logoUrl}
        onChange={(value) => setCfgField('logoUrl', value)}
        placeholder="https://… (replaces the brand mark)"
      />
      <h4 className="adm-sub">Defaults</h4>
      <div className="adm-be-row">
        <SelectField
          label="View"
          value={cfg.defaultView}
          onChange={(value) => setCfgField('defaultView', value)}
          options={VIEW_OPTIONS}
        />
        <SelectField
          label="Mode"
          value={cfg.defaultMode}
          onChange={(value) => setCfgField('defaultMode', value)}
          options={MODE_OPTIONS}
        />
        <SelectField
          label="Theme"
          value={cfg.defaultTheme}
          onChange={(value) => setCfgField('defaultTheme', value)}
          options={THEME_OPTIONS}
        />
        <label className="adm-field">
          <span>Stale after (days)</span>
          <input
            className="adm-in"
            type="number"
            min="1"
            value={cfg.staleDays}
            onChange={(event) => setCfgField('staleDays', event.target.value)}
            placeholder="120"
          />
        </label>
      </div>
      <p className="adm-hint">
        Defaults seed first-load state only; a shared ?-link or an in-session change always wins. Small
        screens still open the Table.
      </p>
      <h4 className="adm-sub">Card layout</h4>
      <p className="adm-hint">
        Drag any card on the graph to reposition it (admin only). Positions are saved with the config below
        and apply for everyone after
        {DEV ? ' regenerate / publish' : ' republish'}.
      </p>
      <div className="adm-be-row">
        <span className="adm-wire-name">{layoutSummary}</span>
        {layoutCount ? (
          <button
            className="btn ghost"
            onClick={onResetLayout}
            title="Clear all dragged positions and revert to the auto-layout"
          >
            Reset layout
          </button>
        ) : null}
      </div>
      <h4 className="adm-sub">Group descriptions</h4>
      <p className="adm-hint">Shown in the sidebar when a cluster box is clicked. Leave blank to hide.</p>
      {regionLabels.map((label) => (
        <label className="adm-field" key={label}>
          <span>{label}</span>
          <input
            className="adm-in adm-wide"
            value={regionNotes[label] || ''}
            onChange={(event) => setRegionNotes((notes) => ({ ...notes, [label]: event.target.value }))}
            placeholder={`What lives in the ${label} group…`}
          />
        </label>
      ))}
      {!DEV ? (
        <div className="adm-add">
          <button className="btn ghost" onClick={() => copy(toJson(config), 'Copied config.json')}>
            Copy config.json
          </button>
          <button className="btn ghost" onClick={() => download('config.json', toJson(config))}>
            <Icon name="download" /> config
          </button>
        </div>
      ) : null}
    </>
  )
}

// Colour encodes provenance: blue = from the committed data, green = added this session, red
// strike-through = removed this session.
function wiringChip(isOn, isChanged) {
  if (isChanged) {
    return {
      className: 'adm-chip' + (isOn ? ' on added' : ' removed'),
      title: isOn ? 'Added this session' : 'Removed this session',
    }
  }
  return { className: 'adm-chip' + (isOn ? ' on' : ''), title: isOn ? 'System-defined wiring' : '' }
}

function WiringTab({ clients, beIds, feBe, feBeChanged, toggleFeBe, assetConsumers, toggleAssetConsumer }) {
  return (
    <>
      <p className="adm-hint">
        Which frontend calls which backend (FE_BE). Toggle the backends each client talks to.
      </p>
      {clients.map((client) => (
        <div className="adm-wire" key={client}>
          <span className="adm-wire-name mono">{client}</span>
          <div className="adm-chips">
            {beIds.map((backendId) => {
              const chip = wiringChip(
                (feBe[client] || []).includes(backendId),
                feBeChanged(client, backendId),
              )
              return (
                <button
                  key={backendId}
                  className={chip.className}
                  onClick={() => toggleFeBe(client, backendId)}
                  title={chip.title}
                >
                  {backendId}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <h4 className="adm-sub">Apps that consume the shared asset repo</h4>
      <div className="adm-chips">
        {clients.map((client) => (
          <button
            key={client}
            className={'adm-chip' + (assetConsumers.includes(client) ? ' on' : '')}
            onClick={() => toggleAssetConsumer(client)}
          >
            {client}
          </button>
        ))}
      </div>
    </>
  )
}

function SaasNamesDatalist({ saasNames }) {
  return (
    <datalist id="adm-saas-names">
      {saasNames.map((name) => (
        <option key={name} value={name} />
      ))}
    </datalist>
  )
}

function NewSaasInput({ backendId, addExternal, setSaasAddingFor }) {
  const onKeyDown = (event) => {
    if (event.key === 'Enter') {
      addExternal(backendId, event.target.value)
      setSaasAddingFor(backendId, false)
    } else if (event.key === 'Escape') {
      setSaasAddingFor(backendId, false)
    }
  }
  const onBlur = (event) => {
    addExternal(backendId, event.target.value)
    setSaasAddingFor(backendId, false)
  }
  return (
    <input
      className="adm-in adm-saas-new"
      list="adm-saas-names"
      autoFocus
      placeholder="new SaaS name — Enter to add"
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  )
}

function AddSaasSelect({ backendId, assigned, saasNames, addExternal, setSaasAddingFor }) {
  const onChange = (event) => {
    const value = event.target.value
    if (value === NEW_SAAS_OPTION) setSaasAddingFor(backendId, true)
    else addExternal(backendId, value)
  }
  return (
    <select className="adm-in adm-saas-add" value="" onChange={onChange}>
      <option value="">+ add SaaS…</option>
      {saasNames
        .filter((name) => !assigned.includes(name))
        .map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      <option value={NEW_SAAS_OPTION}>+ new SaaS…</option>
    </select>
  )
}

function SaasTab({
  beIds,
  externals,
  extChanged,
  saasNames,
  saasAdding,
  setSaasAddingFor,
  addExternal,
  removeExternal,
}) {
  return (
    <>
      <p className="adm-hint">
        Which external SaaS each backend talks to (backendExternals). Pick from the dropdown, or choose “+ new
        SaaS…” to add one not yet listed. A backend row is highlighted when hand-edited.
      </p>
      {beIds.map((backendId) => (
        <div className={'adm-wire' + (extChanged(backendId) ? ' changed' : '')} key={backendId}>
          <span className="adm-wire-name mono">{backendId}</span>
          <div className="adm-saas-list">
            {(externals[backendId] || []).map((name, index) => (
              <span className="adm-saas-chip" key={name + index}>
                {name}
                <button
                  className="adm-x"
                  onClick={() => removeExternal(backendId, index)}
                  title={`remove ${name}`}
                >
                  <Icon name="close" />
                </button>
              </span>
            ))}
            {saasAdding[backendId] ? (
              <NewSaasInput
                backendId={backendId}
                addExternal={addExternal}
                setSaasAddingFor={setSaasAddingFor}
              />
            ) : (
              <AddSaasSelect
                backendId={backendId}
                assigned={externals[backendId] || []}
                saasNames={saasNames}
                addExternal={addExternal}
                setSaasAddingFor={setSaasAddingFor}
              />
            )}
          </div>
        </div>
      ))}
      <SaasNamesDatalist saasNames={saasNames} />
    </>
  )
}

function ServicesTab({ svcRows, setSvcRow, addSvcRow, removeSvcRow, repoFolders, svcNames }) {
  return (
    <>
      <p className="adm-hint">
        Service ↔ repo identity (#16). By default a component's service is its inventory name and its repo is
        the one it's scanned from — add an override only to link a repo-less service (e.g. a monorepo sibling
        like device-data-access) to its owning repo, or leave the repo blank for a genuinely repo-less
        service. Applied on the next “Regenerate data”.
      </p>
      {svcRows.map((row, index) => (
        <div className="adm-wire" key={index}>
          <input
            className="adm-in mono"
            list="adm-svc-names"
            value={row.name}
            onChange={(event) => setSvcRow(index, { name: event.target.value })}
            placeholder="inventory service name"
          />
          <select
            className="adm-in mono"
            value={row.repo}
            onChange={(event) => setSvcRow(index, { repo: event.target.value })}
          >
            <option value="">— (repo-less)</option>
            {uniqueTruthy([row.repo, ...repoFolders]).map((folder) => (
              <option key={folder} value={folder}>
                {folder}
              </option>
            ))}
          </select>
          <button className="adm-x" onClick={() => removeSvcRow(index)} title="remove mapping">
            <Icon name="close" />
          </button>
        </div>
      ))}
      <datalist id="adm-svc-names">
        {svcNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <div className="adm-add">
        <button className="btn" onClick={addSvcRow}>
          + Add mapping
        </button>
      </div>
    </>
  )
}

// The row's current value stays selectable even when it's not among the known options.
function PickList({ className, value, options, onChange }) {
  return (
    <select className={className} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">—</option>
      {uniqueTruthy([value, ...options]).map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  )
}

function IntegrationsTab({
  rows,
  codeDerivedCount,
  beIds,
  targetNames,
  saasNames,
  rowChanged,
  setRow,
  setRowVerified,
  addRow,
  removeRow,
}) {
  const fieldClass = (base, index, field) => base + (rowChanged(index, field) ? ' changed' : '')
  return (
    <>
      <p className="adm-hint">
        Service-to-service edges (integrations.csv). Both-backend rows render in the Resources layer; the rest
        as service links. Uncheck “verified” for inferred edges (renders dotted + dimmed).
        {codeDerivedCount
          ? ` ${codeDerivedCount} further edges are derived from the backend code (Kafka topics via backend-scan) — they regenerate on every run and aren't edited here.`
          : ''}
      </p>
      <table className="adm-tbl">
        <thead>
          <tr>
            <th>Source</th>
            <th>Target</th>
            <th>Proto</th>
            <th>Channel</th>
            <th>✓</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td>
                <PickList
                  className={fieldClass('adm-in mono', index, 'source')}
                  value={row.source}
                  options={beIds}
                  onChange={(source) => setRow(index, { source })}
                />
              </td>
              <td>
                <PickList
                  className={fieldClass('adm-in mono', index, 'target')}
                  value={row.target}
                  options={targetNames}
                  onChange={(target) => setRow(index, { target })}
                />
              </td>
              <td>
                <select
                  className={fieldClass('adm-in', index, 'protocol')}
                  value={row.protocol}
                  onChange={(event) => setRow(index, { protocol: event.target.value })}
                >
                  <option>REST</option>
                  <option>Kafka</option>
                </select>
              </td>
              <td>
                <input
                  className={fieldClass('adm-in', index, 'channel')}
                  value={row.channel}
                  onChange={(event) => setRow(index, { channel: event.target.value })}
                />
              </td>
              <td className="adm-ctr">
                <input
                  type="checkbox"
                  checked={isVerified(row.note)}
                  onChange={(event) => setRowVerified(index, event.target.checked)}
                  title={row.note || ''}
                />
              </td>
              <td>
                <button className="adm-x" onClick={() => removeRow(index)} title="remove row">
                  <Icon name="close" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <SaasNamesDatalist saasNames={saasNames} />
      <div className="adm-add">
        <button className="btn" onClick={addRow}>
          + Add integration
        </button>
      </div>
    </>
  )
}

function GapEditor({ repo, inventoryEntry, gapVal, setGap }) {
  const hintFor = (field) => field + ' ' + (inventoryEntry?.[field] ? '(' + inventoryEntry[field] + ')' : '')
  return (
    <>
      <div className="adm-be-row">
        <input
          className="adm-in"
          value={gapVal(repo, 'owner')}
          onChange={(event) => setGap(repo, 'owner', event.target.value)}
          placeholder={hintFor('owner')}
        />
        <input
          className="adm-in"
          value={gapVal(repo, 'status')}
          onChange={(event) => setGap(repo, 'status', event.target.value)}
          placeholder={hintFor('status')}
        />
        <input
          className="adm-in"
          value={gapVal(repo, 'contact')}
          onChange={(event) => setGap(repo, 'contact', event.target.value)}
          placeholder="technical contact"
        />
      </div>
      <input
        className="adm-in adm-wide"
        value={gapVal(repo, 'description')}
        onChange={(event) => setGap(repo, 'description', event.target.value)}
        placeholder="description fallback"
      />
    </>
  )
}

function InventoryTab({ gapRepos, invByName, invExtra, gapVal, setGap }) {
  return (
    <>
      <p className="adm-hint">
        Repos with no/partial inventory topics. Best fixed by setting topics on the GitHub repo; this writes
        inventory-extra.json fallbacks for what can’t go on a repo. The Documentation link/label live on the
        repo too, as the <code>doc-url</code> / <code>doc-label</code> custom properties.
        {!invExtra && DEV ? ' (loading inventory-extra.json…)' : ''}
        {!DEV ? ' Editing requires the dev server; the gaps are listed read-only here.' : ''}
      </p>
      {gapRepos.length === 0 ? <p className="adm-hint">No gaps — every component is curated. 🎉</p> : null}
      {gapRepos.map((repo) => {
        const inventoryEntry = invByName[repo]
        return (
          <div className="adm-be" key={repo}>
            <div className="adm-be-row">
              <span className="adm-wire-name mono">{repo}</span>
              {inventoryEntry ? (
                <span className="adm-tag">{inventoryEntry.type || 'no type'}</span>
              ) : (
                <span className="adm-tag warn">uncurated</span>
              )}
            </div>
            {DEV ? (
              <GapEditor repo={repo} inventoryEntry={inventoryEntry} gapVal={gapVal} setGap={setGap} />
            ) : null}
          </div>
        )
      })}
    </>
  )
}
