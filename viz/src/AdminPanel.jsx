import { useEffect, useMemo, useState } from 'react'
import { Icon } from './icons.jsx'
import { resolveClusters, STRUCTURAL_REGIONS } from './graph.js'

// Admin panel — edits the CURATED bits of the model that can't be auto-derived from the
// clone/scan/inventory pipeline: backend topology (host/kind/wiring), FE→BE wiring, the
// integrations.csv service edges, and inventory-extra.json gap-filling.
//
// Source of truth stays git-committed. Under `npm run dev` the panel reads the raw files via
// /api/curation and writes them back via /api/save-curation (then you hit "Regenerate data").
// In read-only deploys (Pages / a wiki embed) there's no server, so it seeds from the
// already-loaded data and offers copy/download of the edited files to paste into the repo.

const DEV = import.meta.env.DEV
const DEFAULT_TITLE = 'Architecture Map'
const clone = (x) => JSON.parse(JSON.stringify(x ?? null))
// backend-extra.json keys the panel edits directly; everything else passes through a save untouched
const BE_EDITED_KEYS = ['_comment', 'backends', 'feBe', 'backendExternals', 'assetConsumers']
const beRestOf = (o) => clone(Object.fromEntries(Object.entries(o || {}).filter(([k]) => !BE_EDITED_KEYS.includes(k))))

const csvCell = (v) => {
  const s = String(v ?? '')
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
const rowsToCsv = (rows) =>
  [
    'Source,Target,Protocol,Channel,Note',
    ...rows.map((r) => [r.source, r.target, r.protocol || 'REST', r.channel || '', r.note || ''].map(csvCell).join(',')),
  ].join('\n') + '\n'
const isVerified = (note) => !/verify/i.test(note || '')
// curated integration rows, in the shape the panel edits. A curated row that code CONFIRMED
// carries via:'code' AND curated:true (assemble.mjs) — it must stay in the CSV on save, or
// saving would silently delete every confirmed curated row.
const seedRows = (integrations) =>
  (integrations || [])
    .filter((r) => r.curated || r.via !== 'code')
    .map((r) => ({
      source: r.source,
      target: r.target,
      protocol: r.protocol || 'REST',
      channel: r.channel || '',
      note: r.note || '',
    }))

function download(name, text, type = 'application/json') {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

export default function AdminPanel({ data, layout, onResetLayout, onClose, onSaved }) {
  const [tab, setTab] = useState('settings')
  const [comment, setComment] = useState('')
  const [cfg, setCfg] = useState(() => ({
    title: data.config?.title || '',
    subtitle: data.config?.subtitle || '',
    logoUrl: data.config?.logoUrl || '',
    defaultView: data.config?.defaultView || '',
    defaultMode: data.config?.defaultMode || '',
    defaultTheme: data.config?.defaultTheme || '',
    staleDays: data.config?.staleDays ?? '',
  }))
  const setCfgField = (k, v) => setCfg((c) => ({ ...c, [k]: v }))
  const [backends, setBackends] = useState(() => clone(data.backendTopology?.backends) || [])
  const [feBe, setFeBe] = useState(() => clone(data.backendTopology?.feBe) || {})
  const [externals, setExternals] = useState(() => clone(data.backendTopology?.backendExternals) || {})
  const [assetConsumers, setCssAssets] = useState(() => clone(data.backendTopology?.assetConsumers) || [])
  // backend-extra.json keys this panel doesn't edit (serviceEdges, contentRepos, assetsSource, …)
  // ride along untouched so a save can never silently drop them.
  const [beRest, setBeRest] = useState(() => beRestOf(data.backendTopology))
  // Only CURATED rows are editable — code-derived integrations (via:'code', from the backend
  // messaging scan) regenerate on every pipeline run and must not be baked into integrations.csv.
  const [rows, setRows] = useState(() => seedRows(data.integrations))
  // Baselines snapshot the seeded values so hand-edited fields can be highlighted. feBe/externals
  // re-seed from /api/curation below (DEV) so their baselines update there too; rows only ever seed
  // from props, so this initial snapshot is their permanent baseline.
  const [baseRows] = useState(() => seedRows(data.integrations))
  const [baseFeBe, setBaseFeBe] = useState(() => clone(data.backendTopology?.feBe) || {})
  const [baseExternals, setBaseExternals] = useState(() => clone(data.backendTopology?.backendExternals) || {})
  const codeDerivedCount = useMemo(() => (data.integrations || []).filter((r) => r.via === 'code').length, [data])
  const [regionNotes, setRegionNotes] = useState(() => clone(data.config?.regionNotes) || {})
  // Region boxes that can carry a curated description: the team clusters (from the config taxonomy)
  // plus the fixed structural bands. Derived, not hardcoded, so a fork's clusters show up here too.
  const regionLabels = useMemo(() => [...resolveClusters(data.config).map((c) => c.label), ...STRUCTURAL_REGIONS], [data.config])
  // Raw inventory-extra.json. In dev the /api/curation fetch below replaces this with the on-disk
  // file; in read-only deploys it seeds from the bundled copy so Documentation stays editable.
  const [invExtra, setInvExtra] = useState(() => clone(data.inventoryExtra))
  // Service<->repo overrides (#16 service-map.json), edited as rows; empty repo = repo-less service.
  const [svcRows, setSvcRows] = useState(() => Object.entries(data.serviceMap?.services || {}).map(([name, v]) => ({ name, repo: v?.repo ?? '' })))
  const setSvcRow = (i, patch) => setSvcRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const addSvcRow = () => setSvcRows((rs) => [...rs, { name: '', repo: '' }])
  const removeSvcRow = (i) => setSvcRows((rs) => rs.filter((_, j) => j !== i))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(DEV ? null : 'Read-only deploy — edits can be copied/downloaded, then committed to the repo.')

  // In dev, prefer the raw committed files (carry the _comment + the full inventory-extra.json,
  // which is merged away in the served data). Falls back silently to the seeded data otherwise.
  useEffect(() => {
    if (!DEV) return
    let alive = true
    fetch('/api/curation')
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (!alive || !c) return
        if (c.backendExtra) {
          setComment(c.backendExtra._comment || '')
          if (c.backendExtra.backends) setBackends(c.backendExtra.backends)
          if (c.backendExtra.feBe) {
            setFeBe(c.backendExtra.feBe)
            setBaseFeBe(clone(c.backendExtra.feBe))
          }
          if (c.backendExtra.backendExternals) {
            setExternals(c.backendExtra.backendExternals)
            setBaseExternals(clone(c.backendExtra.backendExternals))
          }
          if (c.backendExtra.assetConsumers) setCssAssets(c.backendExtra.assetConsumers)
          setBeRest(beRestOf(c.backendExtra))
        }
        if (c.inventoryExtra) setInvExtra(c.inventoryExtra)
        if (c.serviceMap?.services) setSvcRows(Object.entries(c.serviceMap.services).map(([name, v]) => ({ name, repo: v?.repo ?? '' })))
        if (c.config) {
          setCfg({
            title: c.config.title || '',
            subtitle: c.config.subtitle || '',
            logoUrl: c.config.logoUrl || '',
            defaultView: c.config.defaultView || '',
            defaultMode: c.config.defaultMode || '',
            defaultTheme: c.config.defaultTheme || '',
            staleDays: c.config.staleDays ?? '',
          })
          if (c.config.regionNotes) setRegionNotes(c.config.regionNotes)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const beIds = useMemo(() => backends.map((b) => b.id).filter(Boolean), [backends])
  const clients = useMemo(
    () =>
      (data.repos || [])
        .filter((r) => r.kind === 'client')
        .map((r) => r.folder)
        .sort(),
    [data],
  )
  const saasNames = useMemo(() => [...new Set(Object.values(externals).flat())].sort(), [externals])
  // Options offered for an integration Target: backends + external SaaS + the event bus + any
  // component the map already knows, so the field is a pure pick-list (no free typing).
  const targetNames = useMemo(
    () => [...new Set([...beIds, ...saasNames, 'Kafka', ...(data.inventory || []).map((e) => e.name)].filter(Boolean))].sort(),
    [beIds, saasNames, data],
  )
  const repoFolders = useMemo(() => (data.repos || []).map((r) => r.folder).sort(), [data])
  const svcNames = useMemo(() => (data.inventory || []).map((e) => e.name).sort(), [data])
  // service-map.json payload: rows -> { services: { <name>: { repo } } }; empty repo -> null (repo-less)
  const serviceMapOut = useMemo(
    () => ({
      $comment:
        data.serviceMap?.$comment ||
        'Service<->repo identity map (#16). Default is identity; only overrides listed. Keys are the inventory service name; repo = owning repo folder (or null for repo-less).',
      services: Object.fromEntries(svcRows.filter((r) => r.name.trim()).map((r) => [r.name.trim(), { repo: r.repo.trim() || null }])),
    }),
    [svcRows, data],
  )
  // backend ids referenced by wiring but no longer defined — surfaced so a rename can't silently orphan an edge
  const orphanRefs = useMemo(() => {
    const ref = new Set([...Object.values(feBe).flat(), ...Object.keys(externals)])
    return [...ref].filter((id) => id && !beIds.includes(id))
  }, [feBe, externals, beIds])

  const backendExtra = useMemo(
    () => ({ ...(comment ? { _comment: comment } : {}), backends, feBe, backendExternals: externals, assetConsumers: assetConsumers, ...beRest }),
    [comment, backends, feBe, externals, assetConsumers, beRest],
  )
  const csv = useMemo(() => rowsToCsv(rows), [rows])
  // app-level config (config.json). Empty fields are dropped so an un-set option stays absent and
  // falls back to the app's built-in default rather than pinning a blank value.
  // dragged card positions (App state, scoped per view-mode) ride along in config.json so a curated
  // layout publishes too; an empty layout drops the key entirely (reset → back to the auto-layout).
  const layoutCount = Object.values(layout || {}).reduce((s, m) => s + Object.keys(m || {}).length, 0)
  // keep only non-empty group descriptions
  const cleanRegionNotes = useMemo(() => {
    const out = {}
    for (const [k, v] of Object.entries(regionNotes || {})) if (v && v.trim()) out[k] = v.trim()
    return out
  }, [regionNotes])
  const config = useMemo(() => {
    const days = Number(cfg.staleDays)
    const out = {
      ...data.config,
      title: cfg.title.trim() || undefined,
      subtitle: cfg.subtitle.trim() || undefined,
      logoUrl: cfg.logoUrl.trim() || undefined,
      defaultView: cfg.defaultView || undefined,
      defaultMode: cfg.defaultMode || undefined,
      defaultTheme: cfg.defaultTheme || undefined,
      staleDays: Number.isFinite(days) && days > 0 ? days : undefined,
      layout: layoutCount ? layout : undefined,
      regionNotes: Object.keys(cleanRegionNotes).length ? cleanRegionNotes : undefined,
    }
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
    return out
  }, [data, cfg, layout, layoutCount, cleanRegionNotes])

  // ---- wiring ----
  const toggleFeBe = (client, id) =>
    setFeBe((m) => {
      const cur = new Set(m[client] || [])
      if (cur.has(id)) cur.delete(id)
      else cur.add(id)
      const next = { ...m }
      if (cur.size) next[client] = [...cur]
      else delete next[client]
      return next
    })
  const toggleAssetConsumer = (client) => setCssAssets((xs) => (xs.includes(client) ? xs.filter((x) => x !== client) : [...xs, client]))
  // Per-item edits for the dropdown-based External SaaS editor: add one, remove one by index.
  // De-duped per backend; removing the last one drops the backend key entirely (same shape as CSV).
  const addExternal = (id, val) =>
    setExternals((m) => {
      const v = (val || '').trim()
      if (!v || (m[id] || []).includes(v)) return m
      return { ...m, [id]: [...(m[id] || []), v] }
    })
  const removeExternal = (id, idx) =>
    setExternals((m) => {
      const list = (m[id] || []).filter((_, j) => j !== idx)
      const next = { ...m }
      if (list.length) next[id] = list
      else delete next[id]
      return next
    })
  // Which backend rows currently have the "add a name not in the list" text field open.
  const [saasAdding, setSaasAdding] = useState({})

  // ---- integrations ----
  const setRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const setRowVerified = (i, v) =>
    setRow(i, {
      note: v
        ? (rows[i].note || '').replace(/\s*[—-]?\s*VERIFY/gi, '').trim()
        : /verify/i.test(rows[i].note || '')
          ? rows[i].note
          : (rows[i].note ? rows[i].note + ' — ' : '') + 'VERIFY',
    })
  const addRow = () => setRows((rs) => [...rs, { source: '', target: '', protocol: 'REST', channel: '', note: '' }])
  const removeRow = (i) => setRows((rs) => rs.filter((_, j) => j !== i))
  // manual-edit highlighting — true when a field diverges from its seeded baseline
  const rowChanged = (i, field) => (baseRows[i]?.[field] ?? '') !== (rows[i]?.[field] ?? '')
  const feBeChanged = (c, id) => (baseFeBe[c] || []).includes(id) !== (feBe[c] || []).includes(id)
  const extChanged = (id) => (baseExternals[id] || []).join(', ') !== (externals[id] || []).join(', ')

  // ---- inventory gaps ----
  const gapRepos = useMemo(() => {
    const v = data.validation || {}
    const half = (v.incompleteCuration || []).map((s) => String(s).split(' — ')[0])
    return [...new Set([...(v.uncuratedRepos || []), ...half])].sort()
  }, [data])
  const invByName = useMemo(() => Object.fromEntries((data.inventory || []).map((e) => [e.repoName || e.name, e])), [data])
  const setGap = (repo, field, value) =>
    setInvExtra((ix) => {
      const next = clone(ix) || { repoExtras: {}, nonRepo: [] }
      next.repoExtras = next.repoExtras || {}
      const e = (next.repoExtras[repo] = next.repoExtras[repo] || {})
      if (['owner', 'status', 'description'].includes(field)) {
        e.fallback = e.fallback || {}
        if (value) e.fallback[field] = value
        else delete e.fallback[field]
      } else if (value) e[field] = value
      else delete e[field]
      return next
    })
  const gapVal = (repo, field) => {
    const e = invExtra?.repoExtras?.[repo] || {}
    if (['owner', 'status', 'description'].includes(field)) return e.fallback?.[field] ?? ''
    return e[field] ?? ''
  }

  // Documentation link/label are no longer edited here — they live on each repo as the
  // `doc-url` / `doc-label` org custom properties (github-inventory.mjs → inventory.mjs),
  // maintained on GitHub like technical-contact/abbreviation. See docs/repo-maintenance.md.
  const invExtraJson = useMemo(() => JSON.stringify(invExtra ?? { repoExtras: {}, nonRepo: [] }, null, 2) + '\n', [invExtra])

  async function save() {
    setBusy(true)
    setMsg(null)
    try {
      const body = { backendExtra, integrationsCsv: csv, config, serviceMap: serviceMapOut }
      if (invExtra) body.inventoryExtra = invExtra
      const r = await fetch('/api/save-curation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const out = await r.json()
      if (!r.ok || out.ok === false) throw new Error(JSON.stringify(out))
      setMsg(`Saved ${out.written.join(', ')}. Run “Regenerate data” to apply, or it lands on the next nightly.`)
      onSaved?.()
    } catch (e) {
      setMsg('Save failed (is the dev server running?) — ' + String(e.message || e).slice(0, 200))
    } finally {
      setBusy(false)
    }
  }

  const Tab = ({ id, children }) => (
    <button className={'adm-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
      {children}
    </button>
  )

  return (
    <div className="legend-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Admin — curation editor">
      <div className="legend-card adm-card" onClick={(e) => e.stopPropagation()}>
        <div className="legend-head">
          <h3>Admin · curate the model</h3>
          <button className="btn ghost" onClick={onClose} aria-label="Close admin">
            <Icon name="close" />
          </button>
        </div>

        <div className="adm-tabs">
          <Tab id="settings">Settings</Tab>
          <Tab id="wiring">FE→BE wiring</Tab>
          <Tab id="saas">External SaaS ({beIds.length})</Tab>
          <Tab id="services">Services ({svcRows.length})</Tab>
          <Tab id="integrations">Integrations ({rows.length})</Tab>
          <Tab id="inventory">Inventory gaps ({gapRepos.length})</Tab>
        </div>

        {orphanRefs.length ? (
          <div className="adm-warn">
            <Icon name="warning" /> wiring references undefined backend ids: {orphanRefs.join(', ')}
          </div>
        ) : null}

        <div className="adm-body">
          {tab === 'settings' ? (
            <>
              <p className="adm-hint">
                App-wide appearance & defaults (config.json). Applies for everyone after you save and
                {DEV ? ' hit “Regenerate data” / publish' : ' republish'} (or on the next nightly). Leave a field blank to use the built-in default.
              </p>
              <h4 className="adm-sub">Branding</h4>
              <label className="adm-field">
                <span>Page title</span>
                <input className="adm-in adm-wide" value={cfg.title} onChange={(e) => setCfgField('title', e.target.value)} placeholder={DEFAULT_TITLE} />
              </label>
              <label className="adm-field">
                <span>Subtitle</span>
                <input
                  className="adm-in adm-wide"
                  value={cfg.subtitle}
                  onChange={(e) => setCfgField('subtitle', e.target.value)}
                  placeholder="optional tagline shown next to the title"
                />
              </label>
              <label className="adm-field">
                <span>Logo URL</span>
                <input
                  className="adm-in adm-wide mono"
                  value={cfg.logoUrl}
                  onChange={(e) => setCfgField('logoUrl', e.target.value)}
                  placeholder="https://… (replaces the brand mark)"
                />
              </label>
              <h4 className="adm-sub">Defaults</h4>
              <div className="adm-be-row">
                <label className="adm-field">
                  <span>View</span>
                  <select className="adm-in" value={cfg.defaultView} onChange={(e) => setCfgField('defaultView', e.target.value)}>
                    <option value="">Built-in (Graph)</option>
                    <option value="graph">Graph</option>
                    <option value="matrix">Matrix</option>
                    <option value="table">Table</option>
                    <option value="integrations">Integrations</option>
                  </select>
                </label>
                <label className="adm-field">
                  <span>Mode</span>
                  <select className="adm-in" value={cfg.defaultMode} onChange={(e) => setCfgField('defaultMode', e.target.value)}>
                    <option value="">Built-in (Dev)</option>
                    <option value="dev">Dev</option>
                    <option value="overview">Overview</option>
                  </select>
                </label>
                <label className="adm-field">
                  <span>Theme</span>
                  <select className="adm-in" value={cfg.defaultTheme} onChange={(e) => setCfgField('defaultTheme', e.target.value)}>
                    <option value="">Built-in (Light)</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </label>
                <label className="adm-field">
                  <span>Stale after (days)</span>
                  <input
                    className="adm-in"
                    type="number"
                    min="1"
                    value={cfg.staleDays}
                    onChange={(e) => setCfgField('staleDays', e.target.value)}
                    placeholder="120"
                  />
                </label>
              </div>
              <p className="adm-hint">
                Defaults seed first-load state only; a shared ?-link or an in-session change always wins. Small screens still open the Table.
              </p>
              <h4 className="adm-sub">Card layout</h4>
              <p className="adm-hint">
                Drag any card on the graph to reposition it (admin only). Positions are saved with the config below and apply for everyone after
                {DEV ? ' regenerate / publish' : ' republish'}.
              </p>
              <div className="adm-be-row">
                <span className="adm-wire-name">
                  {layoutCount ? `${layoutCount} custom card position${layoutCount === 1 ? '' : 's'}` : 'No custom positions — using auto-layout'}
                </span>
                {layoutCount ? (
                  <button className="btn ghost" onClick={onResetLayout} title="Clear all dragged positions and revert to the auto-layout">
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
                    onChange={(e) => setRegionNotes((n) => ({ ...n, [label]: e.target.value }))}
                    placeholder={`What lives in the ${label} group…`}
                  />
                </label>
              ))}
              {!DEV ? (
                <div className="adm-add">
                  <button
                    className="btn ghost"
                    onClick={() => navigator.clipboard?.writeText(JSON.stringify(config, null, 2)).then(() => setMsg('Copied config.json'))}
                  >
                    Copy config.json
                  </button>
                  <button className="btn ghost" onClick={() => download('config.json', JSON.stringify(config, null, 2))}>
                    <Icon name="download" /> config
                  </button>
                </div>
              ) : null}
            </>
          ) : null}

          {tab === 'wiring' ? (
            <>
              <p className="adm-hint">Which frontend calls which backend (FE_BE). Toggle the backends each client talks to.</p>
              {clients.map((c) => (
                <div className="adm-wire" key={c}>
                  <span className="adm-wire-name mono">{c}</span>
                  <div className="adm-chips">
                    {beIds.map((id) => {
                      const on = (feBe[c] || []).includes(id)
                      const changed = feBeChanged(c, id)
                      // Color encodes provenance (not a border): blue = system-defined (from the
                      // committed data), green = hand-added this session, red strike = hand-removed.
                      const cls = 'adm-chip' + (on ? ' on' : '') + (changed ? (on ? ' added' : ' removed') : '')
                      return (
                        <button
                          key={id}
                          className={cls}
                          onClick={() => toggleFeBe(c, id)}
                          title={changed ? (on ? 'Added this session' : 'Removed this session') : on ? 'System-defined wiring' : ''}
                        >
                          {id}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
              <h4 className="adm-sub">Apps that consume the shared asset repo</h4>
              <div className="adm-chips">
                {clients.map((c) => (
                  <button key={c} className={'adm-chip' + (assetConsumers.includes(c) ? ' on' : '')} onClick={() => toggleAssetConsumer(c)}>
                    {c}
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {tab === 'saas' ? (
            <>
              <p className="adm-hint">
                Which external SaaS each backend talks to (backendExternals). Pick from the dropdown, or choose “+ new SaaS…” to add one not yet listed. A
                backend row is highlighted when hand-edited.
              </p>
              {beIds.map((id) => (
                <div className={'adm-wire' + (extChanged(id) ? ' changed' : '')} key={id}>
                  <span className="adm-wire-name mono">{id}</span>
                  <div className="adm-saas-list">
                    {(externals[id] || []).map((name, idx) => (
                      <span className="adm-saas-chip" key={name + idx}>
                        {name}
                        <button className="adm-x" onClick={() => removeExternal(id, idx)} title={`remove ${name}`}>
                          <Icon name="close" />
                        </button>
                      </span>
                    ))}
                    {saasAdding[id] ? (
                      <input
                        className="adm-in adm-saas-new"
                        list="adm-saas-names"
                        autoFocus
                        placeholder="new SaaS name — Enter to add"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            addExternal(id, e.target.value)
                            setSaasAdding((s) => ({ ...s, [id]: false }))
                          } else if (e.key === 'Escape') setSaasAdding((s) => ({ ...s, [id]: false }))
                        }}
                        onBlur={(e) => {
                          addExternal(id, e.target.value)
                          setSaasAdding((s) => ({ ...s, [id]: false }))
                        }}
                      />
                    ) : (
                      <select
                        className="adm-in adm-saas-add"
                        value=""
                        onChange={(e) => {
                          const v = e.target.value
                          if (v === '__new__') setSaasAdding((s) => ({ ...s, [id]: true }))
                          else addExternal(id, v)
                        }}
                      >
                        <option value="">+ add SaaS…</option>
                        {saasNames
                          .filter((n) => !(externals[id] || []).includes(n))
                          .map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        <option value="__new__">+ new SaaS…</option>
                      </select>
                    )}
                  </div>
                </div>
              ))}
              <datalist id="adm-saas-names">
                {saasNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </>
          ) : null}

          {tab === 'services' ? (
            <>
              <p className="adm-hint">
                Service ↔ repo identity (#16). By default a component's service is its inventory name and its repo is the one it's scanned from — add an
                override only to link a repo-less service (e.g. a monorepo sibling like device-data-access) to its owning repo, or leave the repo blank for a
                genuinely repo-less service. Applied on the next “Regenerate data”.
              </p>
              {svcRows.map((r, i) => (
                <div className="adm-wire" key={i}>
                  <input
                    className="adm-in mono"
                    list="adm-svc-names"
                    value={r.name}
                    onChange={(e) => setSvcRow(i, { name: e.target.value })}
                    placeholder="inventory service name"
                  />
                  <select className="adm-in mono" value={r.repo} onChange={(e) => setSvcRow(i, { repo: e.target.value })}>
                    <option value="">— (repo-less)</option>
                    {[...new Set([r.repo, ...repoFolders].filter(Boolean))].map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <button className="adm-x" onClick={() => removeSvcRow(i)} title="remove mapping">
                    <Icon name="close" />
                  </button>
                </div>
              ))}
              <datalist id="adm-svc-names">
                {svcNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              <div className="adm-add">
                <button className="btn" onClick={addSvcRow}>
                  + Add mapping
                </button>
              </div>
            </>
          ) : null}

          {tab === 'integrations' ? (
            <>
              <p className="adm-hint">
                Service-to-service edges (integrations.csv). Both-backend rows render in the Resources layer; the rest as service links. Uncheck “verified” for
                inferred edges (renders dotted + dimmed).
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
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td>
                        <select
                          className={'adm-in mono' + (rowChanged(i, 'source') ? ' changed' : '')}
                          value={r.source}
                          onChange={(e) => setRow(i, { source: e.target.value })}
                        >
                          <option value="">—</option>
                          {[...new Set([r.source, ...beIds].filter(Boolean))].map((id) => (
                            <option key={id} value={id}>
                              {id}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          className={'adm-in mono' + (rowChanged(i, 'target') ? ' changed' : '')}
                          value={r.target}
                          onChange={(e) => setRow(i, { target: e.target.value })}
                        >
                          <option value="">—</option>
                          {[...new Set([r.target, ...targetNames].filter(Boolean))].map((id) => (
                            <option key={id} value={id}>
                              {id}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          className={'adm-in' + (rowChanged(i, 'protocol') ? ' changed' : '')}
                          value={r.protocol}
                          onChange={(e) => setRow(i, { protocol: e.target.value })}
                        >
                          <option>REST</option>
                          <option>Kafka</option>
                        </select>
                      </td>
                      <td>
                        <input
                          className={'adm-in' + (rowChanged(i, 'channel') ? ' changed' : '')}
                          value={r.channel}
                          onChange={(e) => setRow(i, { channel: e.target.value })}
                        />
                      </td>
                      <td className="adm-ctr">
                        <input type="checkbox" checked={isVerified(r.note)} onChange={(e) => setRowVerified(i, e.target.checked)} title={r.note || ''} />
                      </td>
                      <td>
                        <button className="adm-x" onClick={() => removeRow(i)} title="remove row">
                          <Icon name="close" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <datalist id="adm-saas-names">
                {saasNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              <div className="adm-add">
                <button className="btn" onClick={addRow}>
                  + Add integration
                </button>
              </div>
            </>
          ) : null}

          {tab === 'inventory' ? (
            <>
              <p className="adm-hint">
                Repos with no/partial inventory topics. Best fixed by setting topics on the GitHub repo; this writes inventory-extra.json fallbacks for what
                can’t go on a repo. The Documentation link/label live on the repo too, as the <code>doc-url</code> / <code>doc-label</code> custom properties.
                {!invExtra && DEV ? ' (loading inventory-extra.json…)' : ''}
                {!DEV ? ' Editing requires the dev server; the gaps are listed read-only here.' : ''}
              </p>
              {gapRepos.length === 0 ? <p className="adm-hint">No gaps — every component is curated. 🎉</p> : null}
              {gapRepos.map((repo) => {
                const inv = invByName[repo]
                return (
                  <div className="adm-be" key={repo}>
                    <div className="adm-be-row">
                      <span className="adm-wire-name mono">{repo}</span>
                      {inv ? <span className="adm-tag">{inv.type || 'no type'}</span> : <span className="adm-tag warn">uncurated</span>}
                    </div>
                    {DEV ? (
                      <>
                        <div className="adm-be-row">
                          <input
                            className="adm-in"
                            value={gapVal(repo, 'owner')}
                            onChange={(e) => setGap(repo, 'owner', e.target.value)}
                            placeholder={'owner ' + (inv?.owner ? '(' + inv.owner + ')' : '')}
                          />
                          <input
                            className="adm-in"
                            value={gapVal(repo, 'status')}
                            onChange={(e) => setGap(repo, 'status', e.target.value)}
                            placeholder={'status ' + (inv?.status ? '(' + inv.status + ')' : '')}
                          />
                          <input
                            className="adm-in"
                            value={gapVal(repo, 'contact')}
                            onChange={(e) => setGap(repo, 'contact', e.target.value)}
                            placeholder="technical contact"
                          />
                        </div>
                        <input
                          className="adm-in adm-wide"
                          value={gapVal(repo, 'description')}
                          onChange={(e) => setGap(repo, 'description', e.target.value)}
                          placeholder="description fallback"
                        />
                      </>
                    ) : null}
                  </div>
                )
              })}
            </>
          ) : null}
        </div>

        <div className="adm-foot">
          {msg ? (
            <span className={'adm-msg' + (/fail/i.test(msg) ? ' err' : '')}>{msg}</span>
          ) : (
            <span className="adm-msg muted">Source of truth is git-committed; changes apply on regenerate / nightly.</span>
          )}
          <div className="adm-foot-btns">
            <button
              className="btn ghost"
              onClick={() => navigator.clipboard?.writeText(JSON.stringify(backendExtra, null, 2)).then(() => setMsg('Copied backend-extra.json'))}
            >
              Copy backend JSON
            </button>
            <button className="btn ghost" onClick={() => download('backend-extra.json', JSON.stringify(backendExtra, null, 2))}>
              <Icon name="download" /> backend
            </button>
            <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(csv).then(() => setMsg('Copied integrations.csv'))}>
              Copy CSV
            </button>
            <button className="btn ghost" onClick={() => download('integrations.csv', csv, 'text/csv')}>
              <Icon name="download" /> CSV
            </button>
            {tab === 'inventory' ? (
              <>
                <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(invExtraJson).then(() => setMsg('Copied inventory-extra.json'))}>
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
