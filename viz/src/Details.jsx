import React, { useCallback } from 'react'
import { KIND, canonKind, uiHubFoldersOf } from './graph.js'
import { componentAdoption } from './clientGraph.js'
import { Section, KV, StatusChip, docHref } from './ui.jsx'
import { Icon } from './icons.jsx'

function Resizer({ onResize }) {
  // active-drag cleanup: window listeners attached in onMouseDown would leak until the next
  // mouseup if the panel unmounts mid-drag (e.g. Escape closes it)
  const cleanupRef = React.useRef(null)
  React.useEffect(() => () => cleanupRef.current?.(), [])
  const start = useCallback(
    (e) => {
      e.preventDefault()
      let w = null
      const move = (ev) => {
        w = Math.min(720, Math.max(280, window.innerWidth - ev.clientX))
        onResize(w)
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
        cleanupRef.current = null
        // persist once per drag, not per mousemove
        if (w != null)
          try {
            localStorage.setItem('panelW', String(w))
          } catch {}
      }
      document.body.style.cursor = 'col-resize'
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      cleanupRef.current = up
    },
    [onResize],
  )
  return <div className="panel-resizer" onMouseDown={start} title="Drag to resize" />
}

export default function Details({ data, extras, mode, width, onResize, onClose, onNavigate, onDrillIn, config, frameworkConsumers }) {
  const dev = mode === 'dev'
  const nav = onNavigate || (() => {})
  const docSearchUrl = config?.docSearchUrl
  if (data.region) return <RegionDetails region={data.region} width={width} onResize={onResize} onClose={onClose} onNavigate={nav} />
  if (data.screen) return <ScreenDetails screen={data.screen} clientTitle={data.clientTitle} width={width} onResize={onResize} onClose={onClose} />
  const r = data.repo
  if (!r) {
    const res = data.resource
    const kc = KIND[data.kind]?.color || '#888'
    return (
      <aside className="panel" style={{ width, '--kind': kc }}>
        <Resizer onResize={onResize} />
        <button className="close" onClick={onClose} aria-label="Close panel">
          <Icon name="close" />
        </button>
        <div className="panel-head">
          <span className="panel-eyebrow" style={{ color: kc }}>
            {KIND[data.kind]?.label || data.kind}
            {res?.repo ? <span className="panel-eyebrow-sub"> · {res.repo}</span> : null}
          </span>
          <h2>{String(data.title).replace('\n', ' ')}</h2>
        </div>
        {data.inventory?.description || data.subtitle ? <p className="purpose">{data.inventory?.description || data.subtitle}</p> : null}
        {res?.host ? (
          <div className="liveurl">
            <Icon name="api" /> API <b>{res.host}</b>
          </div>
        ) : null}
        {res?.lastCommit ? (
          <div className="liveurl">
            <Icon name="clock" /> last commit {new Date(res.lastCommit).toLocaleDateString()} · {agoLabel(daysAgo(res.lastCommit))}
          </div>
        ) : null}
        {res?.consumers?.length ? (
          <Section title={`Used by (${res.consumers.length})`}>
            <div className="chiprow">
              {res.consumers.map((c) => (
                <button key={c.id} className="nav-chip" onClick={() => nav(c.id)} title={`Go to ${c.label}`}>
                  {c.label}
                </button>
              ))}
            </div>
          </Section>
        ) : null}
        {res?.partners?.length ? (
          <Section title={`Talks to (${res.partners.length})`}>
            <div className="chiprow">
              {res.partners.map((p) => (
                <button key={p.id} className="nav-chip" onClick={() => nav(p.id)} title={`Go to ${p.name}`}>
                  {p.name}
                  {p.channel ? <span className="muted"> · {p.channel}</span> : null}
                </button>
              ))}
            </div>
          </Section>
        ) : null}
        {res?.tooling?.length ? (
          <Section title="Tooling">
            <div className="chiprow">
              {res.tooling.map((c) => (
                <span key={c} className="mod-chip">
                  {c}
                </span>
              ))}
            </div>
          </Section>
        ) : null}
        {res?.modules?.length ? (
          <Section title={`Modules (${res.modules.length})`}>
            <div className="chiprow">
              {res.modules.map((m) => (
                <span key={m} className="mod-chip">
                  {m}
                </span>
              ))}
            </div>
          </Section>
        ) : null}
        <InventorySection inv={data.inventory} docSearchUrl={docSearchUrl} />
        {data.inventory?.name ? (
          <FrameworkAdoptionSection name={data.inventory.name} consumers={frameworkConsumers?.[data.inventory.name]} onNavigate={nav} />
        ) : null}
        <HealthSection health={data.inventory?.health} pushedAt={data.inventory?.pushedAt} />
        <AzureServiceSection inv={data.inventory} />
        <ThirdPartySection inv={data.inventory} />
      </aside>
    )
  }
  const t = r.toolingVersions || {}
  const tf = extras?.testFootprint?.[r.folder]
  const own = extras?.ownership?.perRepo?.[r.folder]
  const purpose = extras?.purposes?.[r.folder]
  // the folder name(s) the graph accepts for the design-system hub (graph.js `uiHubFoldersOf`)
  const isUiHub = uiHubFoldersOf(config).includes(r.folder)
  const components = isUiHub ? extras?.designSystem?.componentCatalog?.publiclyExportedComponents || null : null
  const kc = KIND[r.kind]?.color || '#888'
  return (
    <aside className="panel" style={{ width, '--kind': kc }}>
      <Resizer onResize={onResize} />
      <button className="close" onClick={onClose} aria-label="Close panel">
        <Icon name="close" />
      </button>
      <div className="panel-head">
        <span className="panel-eyebrow" style={{ color: kc }}>
          {KIND[r.kind]?.label || r.kind}
        </span>
        <h2>
          {data.inventory?.name || r.displayName || r.folder}
          {data.stale ? (
            <span className="stale-pill" title={`No commits in ${data.staleDays} days`}>
              stale
            </span>
          ) : null}
        </h2>
      </div>
      <div className="muted">
        {r.name} · {r.defaultBranch}
        {r.displayName && r.displayName !== r.folder ? (
          <>
            {' '}
            · local folder <span className="mono">{r.folder}</span>
          </>
        ) : null}
      </div>
      {r.lastCommit ? (
        <div className={'liveurl' + (data.stale ? ' stale-text' : '')}>
          <Icon name="clock" /> last commit {new Date(r.lastCommit).toLocaleDateString()}
          {data.staleDays != null ? ` · ${data.staleDays}d ago` : ''}
        </div>
      ) : null}
      {r.azure?.lastDeploy ? (
        <div className="liveurl">
          <Icon name="rocket" /> last deploy {new Date(r.azure.lastDeploy).toLocaleDateString()} · {agoLabel(daysAgo(r.azure.lastDeploy))}
        </div>
      ) : null}
      {purpose?.text || data.inventory?.description ? <p className="purpose">{purpose?.text || data.inventory?.description}</p> : null}
      <InventorySection inv={data.inventory} docSearchUrl={docSearchUrl} />
      {data.inventory?.name ? (
        <FrameworkAdoptionSection name={data.inventory.name} consumers={frameworkConsumers?.[data.inventory.name]} onNavigate={nav} />
      ) : null}
      <HealthSection health={data.inventory?.health} pushedAt={data.inventory?.pushedAt} />
      <AzureServiceSection inv={data.inventory} />
      <AzureEnvSection azure={r.azure} />
      <ThirdPartySection inv={data.inventory} />
      {r.liveUrl ? (
        <div className="liveurl">
          <Icon name="external" /> hosted at <b>{r.liveUrl}</b>
        </div>
      ) : null}
      {r.apiUrl ? (
        <div className="liveurl">
          <Icon name="api" /> API <b>{r.apiUrl}</b>
        </div>
      ) : null}
      {onDrillIn && extras?.screens?.perRepo?.[r.folder]?.screens?.length ? (
        <button className="btn primary drill-btn" onClick={() => onDrillIn(r.folder)} title="Show this app's screens and the endpoints each one calls">
          <Icon name="integrations" /> View {extras.screens.perRepo[r.folder].screens.length} screens →
        </button>
      ) : null}

      {dev ? (
        <Section title="Tooling">
          <KV k="React" v={t.react} />
          <KV k="Vite" v={t.vite} />
          <KV k="TypeScript" v={t.typescript} />
          <KV k="MUI" v={t.mui} />
          <KV k="Storybook" v={t.storybook} />
          <KV k="Build" v={t.buildTool} />
        </Section>
      ) : null}

      {r.endpoints?.length ? (
        <Section title={`Endpoints used (${r.endpoints.length})`}>
          {r.swagger ? (
            <a className="swaggerlink" href={r.swagger} target="_blank" rel="noreferrer">
              <Icon name="book" /> Swagger / API docs <Icon name="external" />
            </a>
          ) : null}
          <ul className="endpoints">
            {r.endpoints.map((e) => {
              const href = r.endpointLinks?.[e] || r.swagger
              return (
                <li key={e} className="mono small">
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer">
                      {e}
                    </a>
                  ) : (
                    e
                  )}
                </li>
              )
            })}
          </ul>
        </Section>
      ) : null}

      {r.internalDeps?.length ? (
        <Section title="Internal deps">
          {r.internalDeps.map((d) => (
            <button key={d.name} className="kv kv-nav" onClick={() => nav(d.name)} title={`Go to ${d.name.replace(/^@[^/]+\//, '')}`}>
              <span>{d.name.replace(/^@[^/]+\//, '')}</span>
              <b>{d.version + (d.dev ? ' (dev)' : '')}</b>
            </button>
          ))}
        </Section>
      ) : null}

      {r.externals?.length ? (
        <Section title="Integrations">
          <div className="chiprow">
            {r.externals.map((e) => (
              <span key={e.name} className="ext-chip" title={e.via}>
                {e.name}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      {components?.length ? (
        <Section title={`Components (${components.length} public)`}>
          <div className="chiprow">
            {components.map((c) => (
              <span key={c} className="comp-chip">
                {c}
              </span>
            ))}
          </div>
        </Section>
      ) : null}
      {isUiHub ? <AdoptionSection rows={componentAdoption(extras)} onNavigate={nav} /> : null}

      {dev && r.moduleGraph?.topFolders?.length ? (
        <Section title={`Modules (src/)`}>
          <div className="chiprow">
            {r.moduleGraph.topFolders.map((f) => (
              <span key={f} className="mod-chip">
                {f}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      {r.feToBe?.backends?.length ? (
        <Section title="Resources">
          <ul>
            {r.feToBe.backends.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <div className="sec-note">inferred from env vars{r.feToBe.method ? ` (${r.feToBe.method})` : ''} — may be incomplete</div>
        </Section>
      ) : null}

      {dev && r.deployment?.[0]?.target ? (
        <Section title="Deployments">
          {r.deployment
            .filter((d) => d.target)
            .map((d) => (
              <div key={d.workflow} className="dpl">
                <div className="mono">{d.workflow}</div>
                <div className="muted small">{(d.environments || d.branches || []).join(', ')}</div>
                <div className="small">{(d.target || []).join(' · ')}</div>
              </div>
            ))}
        </Section>
      ) : null}

      {dev && tf ? (
        <Section title="Tests">
          <KV k="Unit files" v={tf.unitTestFiles} />
          <KV k="Stories" v={tf.stories} />
          {tf.playwrightSpecs != null ? <KV k="Playwright" v={tf.playwrightSpecs} /> : null}
          <KV k="Coverage" v={tf.coverage ? tf.coverage.lines + '% lines' : 'none committed'} />
        </Section>
      ) : null}

      <Section title="Ownership">
        {own?.present ? (
          own.owners.map((o) => (
            <div key={o} className="mono small">
              {o}
            </div>
          ))
        ) : (
          <div className="muted small">no CODEOWNERS</div>
        )}
      </Section>
    </aside>
  )
}

// Cluster / group details — opened when a region box is clicked. Shows the group description, a
// kind breakdown, and the (clickable) member list.
function RegionDetails({ region, width, onResize, onClose, onNavigate }) {
  const kc = region.color || '#888'
  const members = region.members || []
  const byKind = {}
  for (const m of members) {
    const k = canonKind(m.kind) // backend→service, extsvc→external, so no duplicate Type buckets
    byKind[k] = (byKind[k] || 0) + 1
  }
  const breakdown = Object.entries(byKind).sort((a, b) => b[1] - a[1])
  return (
    <aside className="panel" style={{ width, '--kind': kc }}>
      <Resizer onResize={onResize} />
      <button className="close" onClick={onClose} aria-label="Close panel">
        <Icon name="close" />
      </button>
      <div className="panel-head">
        <span className="panel-eyebrow" style={{ color: kc }}>
          Group · {members.length} {members.length === 1 ? 'component' : 'components'}
        </span>
        <h2>
          <span className="region-swatch" style={{ background: kc }} /> {region.label}
        </h2>
      </div>
      {region.note ? <p className="purpose">{region.note}</p> : null}
      {breakdown.length ? (
        <Section title="Breakdown">
          <div className="chiprow">
            {breakdown.map(([k, n]) => (
              <span key={k} className="mod-chip">
                {KIND[k]?.label || k} · {n}
              </span>
            ))}
          </div>
        </Section>
      ) : null}
      {members.length ? (
        <Section title={`Members (${members.length})`}>
          <div className="chiprow">
            {members.map((m) => (
              <button key={m.id} className="nav-chip" onClick={() => onNavigate(m.id)} title={`Go to ${m.title}`}>
                {m.title}
              </button>
            ))}
          </div>
        </Section>
      ) : null}
    </aside>
  )
}

// One screen (route) inside a client's drill-down view: its path, access roles, source file and the
// backend endpoints it (transitively) calls. Endpoints are best-effort attributed — see screens-gather.mjs.
function ScreenDetails({ screen, clientTitle, width, onResize, onClose }) {
  const kc = KIND.screen.color
  return (
    <aside className="panel" style={{ width, '--kind': kc }}>
      <Resizer onResize={onResize} />
      <button className="close" onClick={onClose} aria-label="Close panel">
        <Icon name="close" />
      </button>
      <div className="panel-head">
        <span className="panel-eyebrow" style={{ color: kc }}>
          Screen{clientTitle ? <span className="panel-eyebrow-sub"> · {clientTitle}</span> : null}
        </span>
        <h2>{screen.name}</h2>
      </div>
      {(screen.paths?.length ? screen.paths : screen.path ? [screen.path] : []).map((p) => (
        <div key={p} className="liveurl">
          <Icon name="external" /> <span className="mono">{p}</span>
        </div>
      ))}
      {screen.file ? <div className="muted mono">{screen.file}</div> : null}
      {screen.roles?.length ? (
        <Section title={`Access roles (${screen.roles.length})`}>
          <div className="chiprow">
            {screen.roles.map((r) => (
              <span key={r} className="mod-chip">
                {r}
              </span>
            ))}
          </div>
        </Section>
      ) : null}
      <Section title={`Endpoints used (${screen.endpoints?.length || 0})`}>
        {screen.endpoints?.length ? (
          <div className="chiprow">
            {screen.endpoints.map((e) => (
              <span key={e} className="mod-chip mono">
                {e}
              </span>
            ))}
          </div>
        ) : (
          <p className="muted">No backend endpoints detected for this screen.</p>
        )}
      </Section>
    </aside>
  )
}

// Live repo health from GitHub (github-inventory): latest CI conclusion, Dependabot alerts by
// severity, last push. Only renders when we have signals for the repo.
function HealthSection({ health, pushedAt }) {
  const ci = health?.ci
  const a = health?.alerts
  if (!ci && !a && !pushedAt) return null
  const sev = a
    ? ['critical', 'high', 'medium', 'low']
        .filter((s) => a[s])
        .map((s) => `${a[s]} ${s}`)
        .join(', ')
    : ''
  return (
    <Section title="Health">
      {ci ? (
        <div className="kv">
          <span>CI</span>
          <a
            className={'ci-chip ci-' + (ci.conclusion || ci.status || 'unknown')}
            href={ci.url}
            target="_blank"
            rel="noreferrer"
            title={`Latest run: ${ci.conclusion || ci.status}`}
          >
            {ci.conclusion || ci.status || 'unknown'}
          </a>
        </div>
      ) : null}
      {a ? (
        <div className="kv">
          <span>Dependabot</span>
          <span className={a.total ? 'alerts-bad' : ''}>{a.total ? `${a.total} open (${sev})` : 'no open alerts'}</span>
        </div>
      ) : null}
      {pushedAt ? <KV k="Last push" v={new Date(pushedAt).toLocaleDateString()} /> : null}
    </Section>
  )
}

// Design-system adoption: which clients/screens consume each @framework/ui export, inverted from
// the per-screen component usage (clientGraph.componentAdoption). Change-impact at a glance.
function AdoptionSection({ rows, onNavigate }) {
  if (!rows?.length) return null
  const nav = onNavigate || (() => {})
  return (
    <Section title={`Design-system adoption (${rows.length} used)`}>
      <table className="adopt-table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.component}>
              <td className="mono">{r.component}</td>
              <td className="adopt-count" title={r.clients.join(', ')}>
                {r.clients.length} client{r.clients.length > 1 ? 's' : ''}
              </td>
              <td className="muted small">
                {r.screens} screen{r.screens > 1 ? 's' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="chiprow adopt-clients">
        {[...new Set(rows.flatMap((r) => r.clients))].sort().map((c) => (
          <button key={c} className="nav-chip" onClick={() => nav(c)} title={`Go to ${c}`}>
            {c}
          </button>
        ))}
      </div>
    </Section>
  )
}

// Component Inventory record — one component's row, as the pipeline assembled it
// Which services build on this framework card (data.frameworkConsumers, keyed by framework name —
// e.g. nucleus). The backend counterpart of the design-system AdoptionSection: consumers with
// their pinned version, red when lagging the highest version any consumer references.
function FrameworkAdoptionSection({ name, consumers, onNavigate }) {
  if (!consumers?.length) return null
  const vp = (v) =>
    String(v || '')
      .replace(/^[~^>=<\s]+/, '')
      .split(/[.\-+]/)
      .map((x) => parseInt(x, 10) || 0)
  const cmp = (a, b) => {
    const A = vp(a),
      B = vp(b)
    for (let i = 0; i < Math.max(A.length, B.length); i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0)
    return 0
  }
  const latest =
    consumers
      .map((c) => c.version)
      .filter(Boolean)
      .sort(cmp)
      .slice(-1)[0] || null
  return (
    <Section title={`Built on ${name} (${consumers.length} service${consumers.length === 1 ? '' : 's'})`}>
      <div className="chiprow">
        {consumers.map((c) => {
          const lag = latest && c.version && cmp(c.version, latest) < 0
          return (
            <button key={c.name} className="nav-chip" onClick={() => onNavigate(c.name)} title={(c.artifacts || []).join(', ')}>
              {c.name}
              {c.version ? <span style={lag ? { color: '#c62828' } : undefined}> · {c.version}</span> : null}
            </button>
          )
        })}
      </div>
      {latest ? <div className="muted small">latest referenced: {latest} — red = lagging</div> : null}
    </Section>
  )
}

function InventorySection({ inv, docSearchUrl }) {
  if (!inv) return null
  return (
    <Section title="Component inventory">
      <div className="inv-head">
        <StatusChip status={inv.status} />
        {inv.abbr ? <span className="inv-abbr">{inv.abbr}</span> : null}
        <span className="inv-type">{inv.type + (inv.subtype ? ' · ' + inv.subtype : '')}</span>
      </div>
      <KV k="Owner (team)" v={inv.owner} />
      {/* derived (build files / toolingVersions / GitHub primaryLanguage), never curated */}
      <KV k="Stack" v={[inv.language, inv.framework].filter(Boolean).join(' · ')} />
      <KV k="Technical contact" v={inv.contact} />
      {inv.applications?.length ? (
        <div className="kv">
          <span>Application</span>
          <b>{inv.applications.join(', ')}</b>
        </div>
      ) : null}
      <KV k="Introduced" v={inv.introDate} />
      <KV k="Sunsetting" v={inv.sunsetDate} />
      {inv.comment ? <div className="inv-note">{inv.comment}</div> : null}
      {/* Documentation link. `docUrl` is the real link; `doc` the label. Entries with only a
          label (no url) route to a wiki quick-search so the link still resolves meanwhile. */}
      {(inv.doc || inv.docUrl) && docHref(inv.doc, inv.docUrl, docSearchUrl) ? (
        <a
          className="inv-edit"
          href={docHref(inv.doc, inv.docUrl, docSearchUrl)}
          target="_blank"
          rel="noreferrer"
          title={inv.doc ? `Open: ${inv.doc}` : 'Open the documentation'}
        >
          <Icon name="book" /> {inv.doc || 'Documentation'} <Icon name="external" />
        </a>
      ) : null}
      {/* TODO(logz.io): once a deep-link pattern exists (account/region + service-name query), add a
          "Traces" link here, e.g. https://app-eu.logz.io/#/dashboard/...&query=service:<name>. */}
      {/* Curation is done on the repo itself (topics + description + custom properties), not in this
          read-only map — so link straight to the source of truth instead of editing here. */}
      {inv.repo ? (
        <a
          className="inv-edit"
          href={inv.repo}
          target="_blank"
          rel="noreferrer"
          title="Edit topics, description, and custom properties on GitHub — the map refreshes nightly"
        >
          <Icon name="github" /> Edit on GitHub <Icon name="external" />
        </a>
      ) : null}
    </Section>
  )
}

// Azure overlay (azure-gather.mjs): real environments + domains + deploy dates per FE app.
const ENV_ORDER = ['dev', 'test', 'pre', 'prod', 'demo', 'poc', 'sandbox', 'e2e']
const daysAgo = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null)
const agoLabel = (d) => (d == null ? null : d <= 0 ? 'today' : `${d}d ago`)
function AzureEnvSection({ azure }) {
  if (!azure?.envs || !Object.keys(azure.envs).length) return null
  const envs = Object.keys(azure.envs).sort((a, b) => (ENV_ORDER.indexOf(a) + 1 || 99) - (ENV_ORDER.indexOf(b) + 1 || 99))
  return (
    <Section title="Environments (Azure)">
      {envs.map((env) => {
        const e = azure.envs[env]
        const d = daysAgo(e.deployed)
        return (
          <React.Fragment key={env}>
            <div className="kv">
              <span className="env-name">{env}</span>
              <b className="env-val">
                {e.domains?.[0] ? (
                  <a href={'https://' + e.domains[0] + (e.path || '')} target="_blank" rel="noreferrer">
                    {e.domains[0] + (e.path || '')}
                  </a>
                ) : (
                  <span className="muted">no domain</span>
                )}
                {d != null ? <span className={'env-age' + (d > 60 ? ' old' : '')}> · {agoLabel(d)}</span> : null}
              </b>
            </div>
            {(e.modules || []).map((m) => (
              <div key={m} className="env-module">
                <Icon name="child" />{' '}
                <a href={'https://' + m} target="_blank" rel="noreferrer">
                  {m}
                </a>
              </div>
            ))}
          </React.Fragment>
        )
      })}
    </Section>
  )
}
// Azure overlay for backend services: ACR image freshness + matched infra resources.
function AzureServiceSection({ inv }) {
  const az = inv?.azure
  if (!az || (!az.lastPush && !az.infra?.length)) return null
  return (
    <Section title="Azure">
      {az.lastPush ? <KV k="Last image push" v={`${az.lastPush.slice(0, 10)} · ${agoLabel(daysAgo(az.lastPush))}`} /> : null}
      {az.image ? (
        <div className="liveurl">
          <Icon name="box" /> <span className="mono">{az.image}</span>
        </div>
      ) : null}
      {az.infra?.length ? (
        <div className="chiprow" style={{ marginTop: 6 }}>
          {az.infra.map((i) => (
            <span key={i.name} className="mod-chip" title={i.type}>
              {i.name}
            </span>
          ))}
        </div>
      ) : null}
    </Section>
  )
}
// Third-party service metadata (third-party-meta.csv); only filled fields render.
function ThirdPartySection({ inv }) {
  const m = inv?.meta
  if (!m) return null
  return (
    <Section title="Third-party details">
      <KV k="Vendor" v={m.vendor} />
      {m.url ? (
        <div className="liveurl">
          <Icon name="external" />{' '}
          <a href={m.url} target="_blank" rel="noreferrer">
            {m.url}
          </a>
        </div>
      ) : null}
      <KV k="Auth" v={m.auth} />
      <KV k="Data" v={m.dataClassification} />
      <KV k="Criticality" v={m.criticality} />
      <KV k="Contract owner" v={m.contractOwner} />
      <KV k="Environments" v={m.environments} />
      {m.notes ? <div className="inv-note">{m.notes}</div> : null}
    </Section>
  )
}
