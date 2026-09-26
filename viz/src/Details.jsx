import React, { useCallback } from 'react'
import { KIND, canonKind, uiHubFoldersOf } from './graph.js'
import { componentAdoption } from './clientGraph.js'
import { Section, KV, StatusChip, docHref } from './ui.jsx'
import { Icon } from './icons.jsx'

const PANEL_MIN_WIDTH = 280
const PANEL_MAX_WIDTH = 720
const PANEL_WIDTH_STORAGE_KEY = 'panelW'
const UNKNOWN_KIND_COLOR = '#888'
const OTHER_KIND = 'Other'
const LAGGING_VERSION_COLOR = '#c62828'
const MS_PER_DAY = 86400000
// A deploy older than this many days is flagged as old.
const OLD_DEPLOY_DAYS = 60
const ENV_ORDER = ['dev', 'test', 'pre', 'prod', 'demo', 'poc', 'sandbox', 'e2e']
const UNLISTED_ENV_RANK = 99
const ALERT_SEVERITIES = ['critical', 'high', 'medium', 'low']
const PACKAGE_SCOPE = /^@[^/]+\//

const noop = () => {}

const daysAgo = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / MS_PER_DAY) : null)

function agoLabel(days) {
  if (days == null) return null
  return days <= 0 ? 'today' : `${days}d ago`
}

const withoutScope = (packageName) => packageName.replace(PACKAGE_SCOPE, '')

// Arrow keys move the handle by this much; Shift moves it further.
const RESIZE_STEP = 16
const RESIZE_STEP_LARGE = 64

const clampPanelWidth = (width) => Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width))

function savePanelWidth(width) {
  try {
    localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(width))
  } catch {}
}

// The panel sits on the right, so moving the handle left widens it.
function keyboardWidth(key, width, step) {
  if (key === 'ArrowLeft') return width + step
  if (key === 'ArrowRight') return width - step
  if (key === 'Home') return PANEL_MIN_WIDTH
  if (key === 'End') return PANEL_MAX_WIDTH
  return null
}

// Drag handle (mouse, pen or touch) and keyboard separator for the panel's width.
function Resizer({ width, onResize }) {
  // The pointer that owns the drag and the last width it set; a second pointer can't take over.
  const dragRef = React.useRef(null)
  const endDrag = useCallback(() => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    document.body.style.cursor = ''
    if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId)
    // Persist once per drag, not per move.
    if (drag.width != null) savePanelWidth(drag.width)
  }, [])
  // A window blur mid-drag, or the panel unmounting (Escape closes it), ends the drag cleanly.
  React.useEffect(() => {
    window.addEventListener('blur', endDrag)
    return () => {
      window.removeEventListener('blur', endDrag)
      endDrag()
    }
  }, [endDrag])

  const onPointerDown = (event) => {
    if (dragRef.current || event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture?.(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, handle, width: null }
    document.body.style.cursor = 'col-resize'
  }
  const onPointerMove = (event) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.width = clampPanelWidth(window.innerWidth - event.clientX)
    onResize(drag.width)
  }
  const onPointerEnd = (event) => {
    if (dragRef.current?.pointerId === event.pointerId) endDrag()
  }
  const onKeyDown = (event) => {
    const step = event.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP
    const next = keyboardWidth(event.key, width, step)
    if (next == null) return
    event.preventDefault()
    const clamped = clampPanelWidth(next)
    onResize(clamped)
    savePanelWidth(clamped)
  }

  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize details panel"
      aria-valuenow={clampPanelWidth(width)}
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={PANEL_MAX_WIDTH}
      tabIndex={0}
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onKeyDown={onKeyDown}
      title="Drag, or use the arrow keys, to resize"
    />
  )
}

// The frame every details panel shares: resize handle and close button.
function Panel({ width, kindColor, onResize, onClose, children }) {
  return (
    <aside className="panel" style={{ width, '--kind': kindColor }}>
      <Resizer width={width} onResize={onResize || noop} />
      <button className="close" onClick={onClose} aria-label="Close panel">
        <Icon name="close" />
      </button>
      {children}
    </aside>
  )
}

function ChipSection({ title, items, chipClassName = 'mod-chip' }) {
  if (!items?.length) return null
  return (
    <Section title={title}>
      <div className="chiprow">
        {items.map((item) => (
          <span key={item} className={chipClassName}>
            {item}
          </span>
        ))}
      </div>
    </Section>
  )
}

export default function Details({
  data,
  extras,
  mode,
  width,
  onResize,
  onClose,
  onNavigate,
  onDrillIn,
  config,
  frameworkConsumers,
}) {
  const navigate = onNavigate || noop
  if (data.region) {
    return (
      <RegionDetails
        region={data.region}
        width={width}
        onResize={onResize}
        onClose={onClose}
        onNavigate={navigate}
      />
    )
  }
  if (data.screen) {
    return (
      <ScreenDetails
        screen={data.screen}
        clientTitle={data.clientTitle}
        width={width}
        onResize={onResize}
        onClose={onClose}
      />
    )
  }
  const repo = data.repo
  const kind = repo ? repo.kind : data.kind
  const kindColor = KIND[kind]?.color || UNKNOWN_KIND_COLOR
  const bodyProps = { data, navigate, docSearchUrl: config?.docSearchUrl, frameworkConsumers }
  return (
    <Panel width={width} kindColor={kindColor} onResize={onResize} onClose={onClose}>
      {repo ? (
        <RepoBody
          {...bodyProps}
          repo={repo}
          kindColor={kindColor}
          extras={extras}
          isDev={mode === 'dev'}
          config={config}
          onDrillIn={onDrillIn}
        />
      ) : (
        <ResourceBody {...bodyProps} kindColor={kindColor} />
      )}
    </Panel>
  )
}

// Inventory-backed sections shown for both repos and repo-less resources.
function InventorySections({ inventory, docSearchUrl, frameworkConsumers, navigate }) {
  return (
    <>
      <InventorySection inv={inventory} docSearchUrl={docSearchUrl} />
      {inventory?.name ? (
        <FrameworkAdoptionSection
          name={inventory.name}
          consumers={frameworkConsumers?.[inventory.name]}
          onNavigate={navigate}
        />
      ) : null}
      <HealthSection health={inventory?.health} pushedAt={inventory?.pushedAt} />
      <AzureServiceSection inv={inventory} />
    </>
  )
}

// A node with no repo behind it (backend, external service, bus, ...).
function ResourceBody({ data, kindColor, navigate, docSearchUrl, frameworkConsumers }) {
  const resource = data.resource
  const description = data.inventory?.description || data.subtitle
  return (
    <>
      <div className="panel-head">
        <span className="panel-eyebrow" style={{ color: kindColor }}>
          {KIND[data.kind]?.label || data.kind}
          {resource?.repo ? <span className="panel-eyebrow-sub"> · {resource.repo}</span> : null}
        </span>
        <h2>{String(data.title).replace('\n', ' ')}</h2>
      </div>
      {description ? <p className="purpose">{description}</p> : null}
      {resource?.host ? (
        <div className="liveurl">
          <Icon name="api" /> API <b>{resource.host}</b>
        </div>
      ) : null}
      {resource?.lastCommit ? (
        <div className="liveurl">
          <Icon name="clock" /> last commit {new Date(resource.lastCommit).toLocaleDateString()} ·{' '}
          {agoLabel(daysAgo(resource.lastCommit))}
        </div>
      ) : null}
      {resource?.consumers?.length ? (
        <Section title={`Used by (${resource.consumers.length})`}>
          <div className="chiprow">
            {resource.consumers.map((consumer) => (
              <button
                key={consumer.id}
                className="nav-chip"
                onClick={() => navigate(consumer.id)}
                title={`Go to ${consumer.label}`}
              >
                {consumer.label}
              </button>
            ))}
          </div>
        </Section>
      ) : null}
      {resource?.partners?.length ? (
        <Section title={`Talks to (${resource.partners.length})`}>
          <div className="chiprow">
            {resource.partners.map((partner) => (
              <button
                key={partner.id}
                className="nav-chip"
                onClick={() => navigate(partner.id)}
                title={`Go to ${partner.name}`}
              >
                {partner.name}
                {partner.channel ? <span className="muted"> · {partner.channel}</span> : null}
              </button>
            ))}
          </div>
        </Section>
      ) : null}
      <ChipSection title="Tooling" items={resource?.tooling} />
      <ChipSection title={`Modules (${resource?.modules?.length})`} items={resource?.modules} />
      <InventorySections
        inventory={data.inventory}
        docSearchUrl={docSearchUrl}
        frameworkConsumers={frameworkConsumers}
        navigate={navigate}
      />
      <ThirdPartySection inv={data.inventory} />
    </>
  )
}

function RepoBody({
  data,
  repo,
  kindColor,
  extras,
  isDev,
  config,
  onDrillIn,
  navigate,
  docSearchUrl,
  frameworkConsumers,
}) {
  const tooling = repo.toolingVersions || {}
  const testFootprint = extras?.testFootprint?.[repo.folder]
  const ownership = extras?.ownership?.perRepo?.[repo.folder]
  const purpose = extras?.purposes?.[repo.folder]
  const screenCount = extras?.screens?.perRepo?.[repo.folder]?.screens?.length
  const isUiHub = uiHubFoldersOf(config).includes(repo.folder)
  const publicComponents = isUiHub
    ? extras?.designSystem?.componentCatalog?.publiclyExportedComponents || null
    : null
  const description = purpose?.text || data.inventory?.description
  return (
    <>
      <div className="panel-head">
        <span className="panel-eyebrow" style={{ color: kindColor }}>
          {KIND[repo.kind]?.label || repo.kind}
        </span>
        <h2>
          {data.inventory?.name || repo.displayName || repo.folder}
          {data.stale ? (
            <span className="stale-pill" title={`No commits in ${data.staleDays} days`}>
              stale
            </span>
          ) : null}
        </h2>
      </div>
      <div className="muted">
        {repo.name} · {repo.defaultBranch}
        {repo.displayName && repo.displayName !== repo.folder ? (
          <>
            {' '}
            · local folder <span className="mono">{repo.folder}</span>
          </>
        ) : null}
      </div>
      {repo.lastCommit ? (
        <div className={'liveurl' + (data.stale ? ' stale-text' : '')}>
          <Icon name="clock" /> last commit {new Date(repo.lastCommit).toLocaleDateString()}
          {data.staleDays != null ? ` · ${data.staleDays}d ago` : ''}
        </div>
      ) : null}
      {repo.azure?.lastDeploy ? (
        <div className="liveurl">
          <Icon name="rocket" /> last deploy {new Date(repo.azure.lastDeploy).toLocaleDateString()} ·{' '}
          {agoLabel(daysAgo(repo.azure.lastDeploy))}
        </div>
      ) : null}
      {description ? <p className="purpose">{description}</p> : null}
      <InventorySections
        inventory={data.inventory}
        docSearchUrl={docSearchUrl}
        frameworkConsumers={frameworkConsumers}
        navigate={navigate}
      />
      <AzureEnvSection azure={repo.azure} />
      <ThirdPartySection inv={data.inventory} />
      {repo.liveUrl ? (
        <div className="liveurl">
          <Icon name="external" /> hosted at <b>{repo.liveUrl}</b>
        </div>
      ) : null}
      {repo.apiUrl ? (
        <div className="liveurl">
          <Icon name="api" /> API <b>{repo.apiUrl}</b>
        </div>
      ) : null}
      {onDrillIn && screenCount ? (
        <button
          className="btn primary drill-btn"
          onClick={() => onDrillIn(repo.folder)}
          title="Show this app's screens and the endpoints each one calls"
        >
          <Icon name="integrations" /> View {screenCount} screens →
        </button>
      ) : null}

      {isDev ? (
        <Section title="Tooling">
          <KV k="React" v={tooling.react} />
          <KV k="Vite" v={tooling.vite} />
          <KV k="TypeScript" v={tooling.typescript} />
          <KV k="MUI" v={tooling.mui} />
          <KV k="Storybook" v={tooling.storybook} />
          <KV k="Build" v={tooling.buildTool} />
        </Section>
      ) : null}

      <EndpointsSection repo={repo} />

      {repo.internalDeps?.length ? (
        <Section title="Internal deps">
          {repo.internalDeps.map((dependency) => (
            <button
              key={dependency.name}
              className="kv kv-nav"
              onClick={() => navigate(dependency.name)}
              title={`Go to ${withoutScope(dependency.name)}`}
            >
              <span>{withoutScope(dependency.name)}</span>
              <b>{dependency.version + (dependency.dev ? ' (dev)' : '')}</b>
            </button>
          ))}
        </Section>
      ) : null}

      {repo.externals?.length ? (
        <Section title="Integrations">
          <div className="chiprow">
            {repo.externals.map((external) => (
              <span key={external.name} className="ext-chip" title={external.via}>
                {external.name}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      <ChipSection
        title={`Components (${publicComponents?.length} public)`}
        items={publicComponents}
        chipClassName="comp-chip"
      />
      {isUiHub ? <AdoptionSection rows={componentAdoption(extras)} onNavigate={navigate} /> : null}

      {isDev ? <ChipSection title={`Modules (src/)`} items={repo.moduleGraph?.topFolders} /> : null}

      {repo.feToBe?.backends?.length ? (
        <Section title="Resources">
          <ul>
            {repo.feToBe.backends.map((backend) => (
              <li key={backend}>{backend}</li>
            ))}
          </ul>
          <div className="sec-note">
            inferred from env vars{repo.feToBe.method ? ` (${repo.feToBe.method})` : ''} — may be incomplete
          </div>
        </Section>
      ) : null}

      {isDev && repo.deployment?.[0]?.target ? <DeploymentsSection deployments={repo.deployment} /> : null}

      {isDev && testFootprint ? <TestsSection testFootprint={testFootprint} /> : null}

      <Section title="Ownership">
        {ownership?.present ? (
          ownership.owners.map((owner) => (
            <div key={owner} className="mono small">
              {owner}
            </div>
          ))
        ) : (
          <div className="muted small">no CODEOWNERS</div>
        )}
      </Section>
    </>
  )
}

function EndpointsSection({ repo }) {
  if (!repo.endpoints?.length) return null
  return (
    <Section title={`Endpoints used (${repo.endpoints.length})`}>
      {repo.swagger ? (
        <a className="swaggerlink" href={repo.swagger} target="_blank" rel="noreferrer">
          <Icon name="book" /> Swagger / API docs <Icon name="external" />
        </a>
      ) : null}
      <ul className="endpoints">
        {repo.endpoints.map((endpoint) => {
          const href = repo.endpointLinks?.[endpoint] || repo.swagger
          return (
            <li key={endpoint} className="mono small">
              {href ? (
                <a href={href} target="_blank" rel="noreferrer">
                  {endpoint}
                </a>
              ) : (
                endpoint
              )}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

function DeploymentsSection({ deployments }) {
  return (
    <Section title="Deployments">
      {deployments
        .filter((deployment) => deployment.target)
        .map((deployment) => (
          <div key={deployment.workflow} className="dpl">
            <div className="mono">{deployment.workflow}</div>
            <div className="muted small">
              {(deployment.environments || deployment.branches || []).join(', ')}
            </div>
            <div className="small">{(deployment.target || []).join(' · ')}</div>
          </div>
        ))}
    </Section>
  )
}

function TestsSection({ testFootprint }) {
  return (
    <Section title="Tests">
      <KV k="Unit files" v={testFootprint.unitTestFiles} />
      <KV k="Stories" v={testFootprint.stories} />
      {testFootprint.playwrightSpecs != null ? <KV k="Playwright" v={testFootprint.playwrightSpecs} /> : null}
      <KV
        k="Coverage"
        v={testFootprint.coverage ? testFootprint.coverage.lines + '% lines' : 'none committed'}
      />
    </Section>
  )
}

// backend -> service, extsvc -> external, so there are no duplicate type buckets. Members without
// a kind share one "Other" bucket.
function countByCanonicalKind(members) {
  const counts = new Map()
  for (const member of members) {
    const kind = canonKind(member.kind) || OTHER_KIND
    counts.set(kind, (counts.get(kind) || 0) + 1)
  }
  return counts
}

// Opened when a region box is clicked: the group's note, a kind breakdown and the member list.
function RegionDetails({ region, width, onResize, onClose, onNavigate }) {
  const regionColor = region.color || UNKNOWN_KIND_COLOR
  const members = region.members || []
  const breakdown = [...countByCanonicalKind(members)].sort((a, b) => b[1] - a[1])
  return (
    <Panel width={width} kindColor={regionColor} onResize={onResize} onClose={onClose}>
      <div className="panel-head">
        <span className="panel-eyebrow" style={{ color: regionColor }}>
          Group · {members.length} {members.length === 1 ? 'component' : 'components'}
        </span>
        <h2>
          <span className="region-swatch" style={{ background: regionColor }} /> {region.label}
        </h2>
      </div>
      {region.note ? <p className="purpose">{region.note}</p> : null}
      {breakdown.length ? (
        <Section title="Breakdown">
          <div className="chiprow">
            {breakdown.map(([kind, count]) => (
              <span key={kind} className="mod-chip">
                {KIND[kind]?.label || kind} · {count}
              </span>
            ))}
          </div>
        </Section>
      ) : null}
      {members.length ? (
        <Section title={`Members (${members.length})`}>
          <div className="chiprow">
            {members.map((member) => (
              <button
                key={member.id}
                className="nav-chip"
                onClick={() => onNavigate(member.id)}
                title={`Go to ${member.title}`}
              >
                {member.title}
              </button>
            ))}
          </div>
        </Section>
      ) : null}
    </Panel>
  )
}

function routePathsOf(screen) {
  if (screen.paths?.length) return screen.paths
  return screen.path ? [screen.path] : []
}

// One route inside a client's drill-down view. Endpoint attribution is best-effort (see
// screens-gather.mjs).
function ScreenDetails({ screen, clientTitle, width, onResize, onClose }) {
  const screenColor = KIND.screen.color
  return (
    <Panel width={width} kindColor={screenColor} onResize={onResize} onClose={onClose}>
      <div className="panel-head">
        <span className="panel-eyebrow" style={{ color: screenColor }}>
          Screen{clientTitle ? <span className="panel-eyebrow-sub"> · {clientTitle}</span> : null}
        </span>
        <h2>{screen.name}</h2>
      </div>
      {routePathsOf(screen).map((routePath) => (
        <div key={routePath} className="liveurl">
          <Icon name="external" /> <span className="mono">{routePath}</span>
        </div>
      ))}
      {screen.file ? <div className="muted mono">{screen.file}</div> : null}
      <ChipSection title={`Access roles (${screen.roles?.length})`} items={screen.roles} />
      <Section title={`Endpoints used (${screen.endpoints?.length || 0})`}>
        {screen.endpoints?.length ? (
          <div className="chiprow">
            {screen.endpoints.map((endpoint) => (
              <span key={endpoint} className="mod-chip mono">
                {endpoint}
              </span>
            ))}
          </div>
        ) : (
          <p className="muted">No backend endpoints detected for this screen.</p>
        )}
      </Section>
    </Panel>
  )
}

function alertSummary(alerts) {
  return ALERT_SEVERITIES.filter((severity) => alerts[severity])
    .map((severity) => `${alerts[severity]} ${severity}`)
    .join(', ')
}

// Live repo health from GitHub: latest CI conclusion, Dependabot alerts, last push.
function HealthSection({ health, pushedAt }) {
  const ci = health?.ci
  const alerts = health?.alerts
  if (!ci && !alerts && !pushedAt) return null
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
      {alerts ? (
        <div className="kv">
          <span>Dependabot</span>
          <span className={alerts.total ? 'alerts-bad' : ''}>
            {alerts.total ? `${alerts.total} open (${alertSummary(alerts)})` : 'no open alerts'}
          </span>
        </div>
      ) : null}
      {pushedAt ? <KV k="Last push" v={new Date(pushedAt).toLocaleDateString()} /> : null}
    </Section>
  )
}

const plural = (count, word) => `${count} ${word}${count > 1 ? 's' : ''}`

// Which clients and screens use each design-system export: change impact at a glance.
function AdoptionSection({ rows, onNavigate }) {
  if (!rows?.length) return null
  const navigate = onNavigate || noop
  const allClients = [...new Set(rows.flatMap((row) => row.clients))].sort()
  return (
    <Section title={`Design-system adoption (${rows.length} used)`}>
      <table className="adopt-table">
        <tbody>
          {rows.map((row) => (
            <tr key={row.component}>
              <td className="mono">{row.component}</td>
              <td className="adopt-count" title={row.clients.join(', ')}>
                {plural(row.clients.length, 'client')}
              </td>
              <td className="muted small">{plural(row.screens, 'screen')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="chiprow adopt-clients">
        {allClients.map((client) => (
          <button
            key={client}
            className="nav-chip"
            onClick={() => navigate(client)}
            title={`Go to ${client}`}
          >
            {client}
          </button>
        ))}
      </div>
    </Section>
  )
}

// "^1.2.3-rc" -> [1, 2, 3, 0]; non-numeric parts count as 0.
function parseVersion(version) {
  return String(version || '')
    .replace(/^[~^>=<\s]+/, '')
    .split(/[.\-+]/)
    .map((part) => parseInt(part, 10) || 0)
}

function compareVersions(a, b) {
  const partsA = parseVersion(a)
  const partsB = parseVersion(b)
  const length = Math.max(partsA.length, partsB.length)
  for (let i = 0; i < length; i++) {
    const partA = partsA[i] || 0
    const partB = partsB[i] || 0
    if (partA !== partB) return partA - partB
  }
  return 0
}

function latestVersion(consumers) {
  const versions = consumers
    .map((consumer) => consumer.version)
    .filter(Boolean)
    .sort(compareVersions)
  return versions.slice(-1)[0] || null
}

// The services built on this framework, with their pinned version; red when a service lags the
// highest version any consumer references. The backend counterpart of AdoptionSection.
function FrameworkAdoptionSection({ name, consumers, onNavigate }) {
  if (!consumers?.length) return null
  const latest = latestVersion(consumers)
  const serviceWord = consumers.length === 1 ? 'service' : 'services'
  return (
    <Section title={`Built on ${name} (${consumers.length} ${serviceWord})`}>
      <div className="chiprow">
        {consumers.map((consumer) => {
          const isLagging = latest && consumer.version && compareVersions(consumer.version, latest) < 0
          return (
            <button
              key={consumer.name}
              className="nav-chip"
              onClick={() => onNavigate(consumer.name)}
              title={(consumer.artifacts || []).join(', ')}
            >
              {consumer.name}
              {consumer.version ? (
                <span style={isLagging ? { color: LAGGING_VERSION_COLOR } : undefined}>
                  {' '}
                  · {consumer.version}
                </span>
              ) : null}
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
  const documentationUrl = inv.doc || inv.docUrl ? docHref(inv.doc, inv.docUrl, docSearchUrl) : null
  return (
    <Section title="Component inventory">
      <div className="inv-head">
        <StatusChip status={inv.status} />
        {inv.abbr ? <span className="inv-abbr">{inv.abbr}</span> : null}
        <span className="inv-type">{inv.type + (inv.subtype ? ' · ' + inv.subtype : '')}</span>
      </div>
      <KV k="Owner (team)" v={inv.owner} />
      {/* Derived from build files, toolingVersions or GitHub's primary language; never curated. */}
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
      {documentationUrl ? (
        <a
          className="inv-edit"
          href={documentationUrl}
          target="_blank"
          rel="noreferrer"
          title={inv.doc ? `Open: ${inv.doc}` : 'Open the documentation'}
        >
          <Icon name="book" /> {inv.doc || 'Documentation'} <Icon name="external" />
        </a>
      ) : null}
      {/* TODO(logz.io): once a deep-link pattern exists (account/region + service-name query), add a
          "Traces" link here, e.g. https://app-eu.logz.io/#/dashboard/...&query=service:<name>. */}
      {/* Curation happens on the repo itself (topics, description, custom properties), so link to
          that source of truth instead of editing in this read-only map. */}
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

function envRank(env) {
  return ENV_ORDER.indexOf(env) + 1 || UNLISTED_ENV_RANK
}

function EnvironmentRow({ env, environment }) {
  const deployedDaysAgo = daysAgo(environment.deployed)
  const domain = environment.domains?.[0]
  return (
    <>
      <div className="kv">
        <span className="env-name">{env}</span>
        <b className="env-val">
          {domain ? (
            <a href={'https://' + domain + (environment.path || '')} target="_blank" rel="noreferrer">
              {domain + (environment.path || '')}
            </a>
          ) : (
            <span className="muted">no domain</span>
          )}
          {deployedDaysAgo != null ? (
            <span className={'env-age' + (deployedDaysAgo > OLD_DEPLOY_DAYS ? ' old' : '')}>
              {' '}
              · {agoLabel(deployedDaysAgo)}
            </span>
          ) : null}
        </b>
      </div>
      {(environment.modules || []).map((moduleHost) => (
        <div key={moduleHost} className="env-module">
          <Icon name="child" />{' '}
          <a href={'https://' + moduleHost} target="_blank" rel="noreferrer">
            {moduleHost}
          </a>
        </div>
      ))}
    </>
  )
}

// Real environments, domains and deploy dates per frontend app, from the Azure overlay.
function AzureEnvSection({ azure }) {
  if (!azure?.envs || !Object.keys(azure.envs).length) return null
  const envs = Object.keys(azure.envs).sort((a, b) => envRank(a) - envRank(b))
  return (
    <Section title="Environments (Azure)">
      {envs.map((env) => (
        <EnvironmentRow key={env} env={env} environment={azure.envs[env]} />
      ))}
    </Section>
  )
}

// Backend services: container image freshness and matched infra resources.
function AzureServiceSection({ inv }) {
  const azure = inv?.azure
  if (!azure || (!azure.lastPush && !azure.infra?.length)) return null
  return (
    <Section title="Azure">
      {azure.lastPush ? (
        <KV k="Last image push" v={`${azure.lastPush.slice(0, 10)} · ${agoLabel(daysAgo(azure.lastPush))}`} />
      ) : null}
      {azure.image ? (
        <div className="liveurl">
          <Icon name="box" /> <span className="mono">{azure.image}</span>
        </div>
      ) : null}
      {azure.infra?.length ? (
        <div className="chiprow" style={{ marginTop: 6 }}>
          {azure.infra.map((resource) => (
            <span key={resource.name} className="mod-chip" title={resource.type}>
              {resource.name}
            </span>
          ))}
        </div>
      ) : null}
    </Section>
  )
}

// Third-party service metadata; only filled fields render.
function ThirdPartySection({ inv }) {
  const meta = inv?.meta
  if (!meta) return null
  return (
    <Section title="Third-party details">
      <KV k="Vendor" v={meta.vendor} />
      {meta.url ? (
        <div className="liveurl">
          <Icon name="external" />{' '}
          <a href={meta.url} target="_blank" rel="noreferrer">
            {meta.url}
          </a>
        </div>
      ) : null}
      <KV k="Auth" v={meta.auth} />
      <KV k="Data" v={meta.dataClassification} />
      <KV k="Criticality" v={meta.criticality} />
      <KV k="Contract owner" v={meta.contractOwner} />
      <KV k="Environments" v={meta.environments} />
      {meta.notes ? <div className="inv-note">{meta.notes}</div> : null}
    </Section>
  )
}
