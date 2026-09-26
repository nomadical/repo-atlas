// Stateless pieces of the App toolbar. All state stays in App; these only render it.
import { getUser, logout } from '../auth.js'
import { Dropdown } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { GROUP_BY_LABELS, VIEW_LABELS, fullMapUrl } from './urlState.js'
import { dataAgeDays, daysAgoLabel } from './dataAge.js'

// "data N days ago" badge; turns amber once the generated data is older than `staleDays`.
export function DataAge({ generatedAt, staleDays }) {
  const days = dataAgeDays(generatedAt)
  return (
    <span className={'gen' + (days > staleDays ? ' old' : '')} title={new Date(generatedAt).toLocaleString()}>
      data {daysAgoLabel(days)}
    </span>
  )
}

export function Brand({ logoUrl, title, subtitle, generatedAt, dataStaleDays }) {
  return (
    <div className="brand">
      {logoUrl ? <img className="brand-logo" src={logoUrl} alt="" /> : <span className="brand-mark" />}
      <span className="brand-text">{title}</span>
      {subtitle ? <span className="brand-sub">{subtitle}</span> : null}
      {generatedAt ? <DataAge generatedAt={generatedAt} staleDays={dataStaleDays} /> : null}
    </div>
  )
}

export function ThemeToggle({ dark, setDark }) {
  return (
    <button
      className="btn ghost"
      onClick={() => setDark((d) => !d)}
      title="Toggle theme"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <Icon name={dark ? 'sun' : 'moon'} />
    </button>
  )
}

// Kiosk toolbar: just a way out to the full map plus the theme toggle.
export function EmbedToolbarActions({ dark, setDark }) {
  return (
    <>
      <div className="spacer" />
      <a
        className="btn ghost embed-fullmap"
        href={fullMapUrl()}
        target="_blank"
        rel="noreferrer"
        title="Open the full interactive map in a new tab"
      >
        <Icon name="external" /> Open full map
      </a>
      <ThemeToggle dark={dark} setDark={setDark} />
    </>
  )
}

// A dropdown that picks one of `labels` (value -> label).
function ChoiceMenu({ className, labels, value, title, onPick }) {
  return (
    <Dropdown className={className} label={labels[value]} title={title}>
      {(close) =>
        Object.entries(labels).map(([option, label]) => (
          <button
            key={option}
            className={'dd-item' + (value === option ? ' on' : '')}
            onClick={() => {
              onPick(option)
              close()
            }}
          >
            {label}
          </button>
        ))
      }
    </Dropdown>
  )
}

export function ViewMenu({ view, onPick }) {
  return (
    <ChoiceMenu className="view-dd" labels={VIEW_LABELS} value={view} title="Switch view" onPick={onPick} />
  )
}

// Layout-only: the Group filter always stays the team taxonomy, so grouping and filtering compose.
export function GroupByMenu({ groupBy, setGroupBy }) {
  return (
    <ChoiceMenu
      className="groupby-dd"
      labels={GROUP_BY_LABELS}
      value={groupBy}
      title="Group the graph's lanes by team, application or platform (config.json `platforms`)"
      onPick={setGroupBy}
    />
  )
}

export function DetailSwitch({ mode, setMode }) {
  return (
    <label className="switch" title="Show extra detail (tooling/test chips + the richer layout)">
      {/* The visible label hides on narrow toolbars, so the input names itself. */}
      <input
        type="checkbox"
        aria-label="Detail"
        checked={mode === 'dev'}
        onChange={(e) => setMode(e.target.checked ? 'dev' : 'overview')}
      />
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
      <span className="switch-label">Detail</span>
    </label>
  )
}

// What the box does in each view: the graph highlights matches, the other views filter their rows.
const SEARCH_COPY = new Map([
  ['graph', { label: 'Search repos', title: 'Highlight matching cards — Enter to step through matches' }],
  ['table', { label: 'Filter inventory', title: 'Show only the inventory rows that match' }],
  ['matrix', { label: 'Filter components', title: 'Show only the matrix components that match' }],
  ['integrations', { label: 'Filter integrations', title: 'Show only the integrations that match' }],
])

const searchCopy = (view) => SEARCH_COPY.get(view) || SEARCH_COPY.get('graph')

function SearchStepper({ matchIdx, matchCount, stepMatch }) {
  return (
    <span className="search-nav">
      <span className="search-count">{matchCount ? `${matchIdx + 1}/${matchCount}` : '0'}</span>
      {matchCount ? (
        <>
          <button
            className="search-step"
            onClick={() => stepMatch(-1)}
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
          >
            <Icon name="prev" />
          </button>
          <button
            className="search-step"
            onClick={() => stepMatch(1)}
            title="Next match (Enter)"
            aria-label="Next match"
          >
            <Icon name="next" />
          </button>
        </>
      ) : null}
    </span>
  )
}

export function SearchBox({ view, query, setQuery, searchList, matchIdx, stepMatch, frameNodes }) {
  const onKeyDown = (e) => {
    if (e.key !== 'Enter' || view !== 'graph') return
    if (e.shiftKey) stepMatch(-1)
    else if (searchList.length > 1) stepMatch(1)
    else frameNodes(searchList)
  }
  const copy = searchCopy(view)
  return (
    <div className="search-wrap">
      <Icon name="search" className="search-icon" />
      <input
        className="search"
        type="search"
        value={query}
        placeholder={copy.label + '…'}
        aria-label={copy.label}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        title={copy.title}
      />
      {query && view === 'graph' ? (
        <SearchStepper matchIdx={matchIdx} matchCount={searchList.length} stepMatch={stepMatch} />
      ) : null}
    </div>
  )
}

// A repo-name token (optionally followed by " — reason" or " (detail)").
const REPO_TOKEN = /^([A-Za-z0-9][A-Za-z0-9._-]*?)(\s+(?:—|\().*)?$/

// Most pipeline-health tokens are repo names: link those to GitHub so an owner can jump in and
// curate. Free-text notes, or a missing org, render as plain chips.
function HealthChip({ token, org }) {
  const match = REPO_TOKEN.exec(token)
  const repoName = match?.[1]
  if (!repoName || /\s/.test(repoName) || !org) return <span className="mod-chip">{token}</span>
  return (
    <span className="mod-chip">
      <a
        href={`https://github.com/${org}/${repoName}`}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        {repoName}
      </a>
      {match[2] || ''}
    </span>
  )
}

export function HealthButton({ health, org, open, setOpen, wrapRef }) {
  return (
    <div className="health-wrap" ref={wrapRef}>
      <button
        className={'btn health' + (open ? ' on' : '')}
        onClick={() => setOpen((isOpen) => !isOpen)}
        title="Pipeline warnings"
        aria-label={`Pipeline warnings: ${health.count}`}
        aria-expanded={open}
      >
        <Icon name="warning" /> {health.count}
      </button>
      {open ? (
        <div className="health-pop">
          <div className="health-title">Pipeline health</div>
          {health.items.map((item) => (
            <div key={item.kind} className="health-item">
              <div className="health-kind">{item.kind}</div>
              {item.note ? <div className="health-note">{item.note}</div> : null}
              <div className="chiprow">
                {item.list.map((token) => (
                  <HealthChip key={token} token={token} org={org} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function ViewsMenu({ views, persistViews, buildViewParams, copyLink, applyViewParams, setToast }) {
  const saveCurrent = () => {
    const name = window.prompt('Save current view as:')?.trim()
    if (!name) return
    persistViews([...views.filter((v) => v.name !== name), { name, q: buildViewParams().toString() }])
    setToast('Saved view “' + name + '”')
  }
  return (
    <Dropdown
      className="views-dd"
      label="Views"
      badge={views.length || null}
      title="Save, apply or share named views"
    >
      {(close) => (
        <>
          <button
            className="dd-item"
            onClick={() => {
              saveCurrent()
              close()
            }}
          >
            Save current…
          </button>
          <button
            className="dd-item"
            onClick={() => {
              copyLink()
              close()
            }}
          >
            <Icon name="link" /> Copy link
          </button>
          {views.length ? <div className="dd-group">Saved views</div> : null}
          {views.map((savedView) => (
            <div key={savedView.name} className="views-row">
              <button
                className="dd-item views-apply"
                onClick={() => {
                  applyViewParams(savedView.q)
                  close()
                }}
                title="Apply this view"
              >
                {savedView.name}
              </button>
              <button
                className="btn ghost views-del"
                onClick={() => persistViews(views.filter((v) => v.name !== savedView.name))}
                title={'Delete ' + savedView.name}
                aria-label={'Delete view ' + savedView.name}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
        </>
      )}
    </Dropdown>
  )
}

export function UserChip() {
  const user = getUser()
  if (!user) return null
  return (
    <div className="auth-chip" title={user.email || user.username || ''}>
      <span className="auth-user">{user.name}</span>
      <button className="btn ghost" onClick={logout} title="Sign out">
        Logout
      </button>
    </div>
  )
}

const regenerateLabel = (busy) => (busy === 'Regenerate' ? 'Regenerating…' : 'Regenerate data')
const publishLabel = (busy) => (busy === 'Publish' ? 'Publishing…' : 'Publish diagram')

// Every export and pipeline action, in one menu so the toolbar stays on one row. Regenerate/Publish
// hit the Vite dev-server API (vite.config.mjs), which doesn't exist in built deploys, so callers
// only show them under `npm run dev`.
export function MoreMenu({ busy, exportPng, downloadData, openEmbed, showPipelineActions, post }) {
  return (
    <Dropdown
      className="actions-dd"
      label={<Icon name="more" />}
      caret={false}
      align="right"
      title="More actions"
    >
      {(close) => {
        const thenClose = (action) => () => {
          action()
          close()
        }
        return (
          <>
            <button className="dd-item" disabled={!!busy} onClick={thenClose(exportPng)}>
              Export PNG
            </button>
            <button className="dd-item" onClick={thenClose(downloadData)}>
              Download data (JSON)
            </button>
            <button className="dd-item" onClick={thenClose(openEmbed)}>
              Embed this view…
            </button>
            {showPipelineActions ? (
              <>
                <div className="dd-group">Pipeline</div>
                <button
                  className="dd-item"
                  disabled={!!busy}
                  onClick={thenClose(() => post('/api/regenerate', 'Regenerate'))}
                >
                  {regenerateLabel(busy)}
                </button>
                <button
                  className="dd-item"
                  disabled={!!busy}
                  onClick={thenClose(() => post('/api/publish', 'Publish'))}
                >
                  {publishLabel(busy)}
                </button>
              </>
            ) : null}
          </>
        )
      }}
    </Dropdown>
  )
}
