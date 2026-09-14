/* Golden Path compliance screen: interface and state only; all evaluation lives in golden-path/lib/*.mjs.
   Runs in a shadow root whose generic class names would collide with the app's CSS — query via `root`, never `document`. */
import { loadHistory as fetchHistory, loadExceptions as fetchExceptions, loadRules as fetchRules, appendException } from './data.js'
import { replay, auditLine, asOfDate } from '@golden-path/lib/decision-log.mjs'
import { RULES, CHECKS, COLLECTED, SOURCE, setRules, deriveCollected, cellsOf as evaluate, totalOf } from '@golden-path/lib/rules.mjs'
import { SEGMENTS, segmentOf as segmentFor, segmentCounts } from '@golden-path/lib/segments.mjs'
import { expandHistory, statsOn as statsFor } from '@golden-path/lib/history.mjs'
import { toParams, fromParams, defaultState, PARAM_KEYS } from '@golden-path/lib/url.mjs'

const SHELL = `
<div class="top">
  <span class="mark"></span>
  <div><h1>Golden Path compliance</h1><div class="sub">Derived 2026-08-11 03:34 UTC</div></div>
  <nav class="tabs" id="tabs" role="tablist">
    <button role="tab" type="button" data-tab="table" aria-selected="true">Compliance</button>
    <button role="tab" type="button" data-tab="analytics" aria-selected="false">Analytics</button>
  </nav>
  <div class="theme" id="theme" role="group" aria-label="Colour theme">
    <button type="button" data-t="light" aria-pressed="false" aria-label="Light theme" title="Light">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6"/></svg></button>
    <button type="button" data-t="system" aria-pressed="true" aria-label="Match system theme" title="System">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="2.8" y="4.2" width="18.4" height="12.4" rx="1.8"/><path d="M8.6 20.4h6.8" stroke-linecap="round"/></svg></button>
    <button type="button" data-t="dark" aria-pressed="false" aria-label="Dark theme" title="Dark">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/></svg></button>
  </div>
  <a class="switch" id="map-link" href="?">Open Architecture Map
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 5h11v11M19 5 6 18"/></svg></a>
</div>

<div class="wrap">
  <div class="panel summary" id="summary"></div>
  <div class="bar">
    <div class="ms" id="ms-type"></div>
    <div class="ms" id="ms-owner"></div>
    <div class="seg" id="seg">
      <button type="button" data-f="all" aria-pressed="true">All</button>
      <button type="button" data-f="dev" aria-pressed="false">Deviations</button>
      <button type="button" data-f="unk" aria-pressed="false">Not scanned</button>
    </div>
    <div class="ms" id="settings">
      <button class="ms-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="View settings">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.04Z"/></svg>
        Settings<span class="car"></span></button>
      <div class="ms-panel" style="min-width:290px">
        <label class="set"><input type="checkbox" id="grp"><span>Group by owner</span></label>
        <p class="set-title" id="seg-title">Repositories shown</p>
        <div id="segments"></div>
      </div>
    </div>
    <input class="search" id="q" type="search" placeholder="Search components" aria-label="Search components">
  </div>
  <div class="panel tablewrap"><table id="tbl"></table></div>
  <section id="analytics" hidden>
    <div class="rangetop panel" id="rangetop"></div>
    <div class="charts">
      <figure class="panel chart" id="ch-trend"></figure>
      <figure class="panel chart" id="ch-checks"></figure>
    </div>
  </section>
  <div class="foot">
    <span id="hidden-note" style="color:var(--mut)"></span>
    <span class="chip ok"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>Conforms</span>
    <span class="chip bad"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>Deviation</span>
    <span class="chip dev"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5 19 6v5.5c0 4-2.9 7.4-7 8.9-4.1-1.5-7-4.9-7-8.9V6l7-2.5Z"/></svg>Approved deviation</span>
    <span class="chip unk"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7.5" stroke-dasharray="3 2.6"/></svg>Not scanned — counts against the total</span>
    <span class="chip na"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M7 12h10"/></svg>Not applicable — excluded from the total</span>
  </div>
</div>

<div class="toast" id="toast" role="status" aria-live="polite"></div>
<div class="tip" id="tip" role="tooltip"></div>
<aside class="drawer" id="drawer" role="region" aria-labelledby="d-name" aria-hidden="true">
  <div class="d-head">
    <div style="flex:1"><h2 id="d-name" tabindex="-1">—</h2><div class="sub2 d-meta" id="d-sub"></div><div class="d-apps" id="d-apps"></div><div class="d-links" id="d-links"></div></div>
    <div class="d-nav"><button class="d-step" id="d-prev" type="button" aria-label="Previous component" title="Previous (k)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 20-8-8 8-8"/></svg></button><button class="d-step" id="d-next" type="button" aria-label="Next component" title="Next (j)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 4 8 8-8 8"/></svg></button></div>
    <button class="d-close" id="d-close" type="button" aria-label="Close details">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
  </div>
  <div class="d-body" id="d-body"></div>
</aside>
`

// hostEl carries the theme attribute (and so the tokens); returns the teardown for React's effect.
export function mountPage(hostEl, root) {
  // Append, don't assign: the caller's <style> is already in the root and must stay.
  const shell = document.createElement('template')
  shell.innerHTML = SHELL
  root.append(shell.content)
  const $id = (id) => root.getElementById(id)
  // A shadow root retargets events: the element actually clicked comes from composedPath, not e.target.
  const off = []
  const on = (target, type, fn) => {
    target.addEventListener(type, fn)
    off.push(() => target.removeEventListener(type, fn))
  }
  const inside = (e) => e.composedPath()[0] ?? e.target

  function urlFor(repo) {
    const p = new URLSearchParams(location.search)
    const wanted = toParams({ state, range, component: repo })
    for (const k of PARAM_KEYS) {
      if (wanted[k]) p.set(k, wanted[k])
      else p.delete(k)
    }
    const qs = p.toString()
    return qs ? `?${qs}` : location.pathname
  }

  // push for a move Back should undo (tab, component); replace for a refinement like typing a search.
  const writeUrl = ({ push = false, repo = null } = {}) => {
    const url = urlFor(repo)
    if (push) history.pushState({ component: repo }, '', url)
    else history.replaceState({ component: repo }, '', url)
  }

  // Runs before first paint and on Back, so a link and a history entry restore the same view.
  function readUrl() {
    const parsed = fromParams(location.search)
    Object.assign(state, parsed.state)
    range.key = parsed.range.key
    if (range.key === 'custom') {
      range.from = parsed.range.from || ALL_TIME_FROM
      range.to = parsed.range.to || TODAY
      customOpen = true
    } else {
      // A named window is recomputed from the history, not read from the link.
      range.from = RANGES[range.key].from()
      range.to = TODAY
      customOpen = false
    }
  }

  // render() rebuilds the multi-selects, but these three are plain inputs that must be synced by hand.
  function syncControls() {
    $id('q').value = state.q
    $id('grp').checked = state.group
    root.querySelectorAll('#seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === state.filter)))
  }
  // The map is this same app without ?view=golden-path; it deep-links a node with ?sel=<serviceId|folder>.
  const MAP_URL = location.pathname
  $id('map-link').href = MAP_URL
  // org comes from history.json (stamped by append-history from github-meta), so the drawer's
  // repository links point at your own org. Before the first stamped night there is no org to link
  // to, so the link is simply omitted rather than pointed somewhere wrong.
  let ORG = ''
  const REPO_URL = (r) => (ORG ? `https://github.com/${ORG}/${r}` : null)
  const GH =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48l-.01-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.36 1.09 2.93.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85l-.01 2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2.2Z"/></svg>'
  const MAPI =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><circle cx="6" cy="6.5" r="2.6"/><circle cx="18" cy="6.5" r="2.6"/><circle cx="12" cy="17.5" r="2.6"/><path d="M7.9 8.3 10.7 15M16.1 8.3 13.3 15M8.6 6.5h6.8" stroke-linecap="round"/></svg>'

  // The unit is the REPOSITORY, not the inventory component (1:1 today); `arch-map-ignore` repos are dropped.
  let DATA = []
  let HISTORY = [] // [{ d:'YYYY-MM-DD', t:ms, rows:{repo:row} }], oldest first
  let LAST = null,
    TODAY = 0,
    ALL_TIME_FROM = 0

  async function loadHistory() {
    const file = await fetchHistory()
    if (file.org) ORG = file.org
    HISTORY = expandHistory(file)
    LAST = HISTORY[HISTORY.length - 1]
    DATA = Object.values(LAST.rows)
    deriveCollected(DATA) // a check counts as collected once a night carries it
    TODAY = LAST.t // the newest night on record, not the wall clock
    ALL_TIME_FROM = HISTORY[0].t
    range.from = ALL_TIME_FROM
    range.to = TODAY
  }

  // A missing rules file is not fatal — the library keeps its fallback.
  async function loadRules() {
    const file = await fetchRules()
    if (file) setRules(file)
  }

  function renderProvenance() {
    const parts = [`${HISTORY.length} nightly runs`, `latest ${LAST.d}`]
    const s = SOURCE
    if (s?.name) {
      const when = s.version ? ` v${esc(s.version)}` : s.lastModified ? ` · ${esc(s.lastModified)}` : ''
      parts.push(s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>${when}` : esc(s.name) + when)
    }
    // Without the decision log an approved deviation reads as an open one — say so.
    if (!decisionLogRead)
      parts.push('<span class="warn-note" title="Approved deviations cannot be shown, so they are counted as open ones.">decisions unavailable</span>')
    root.querySelector('.top .sub').innerHTML = parts.join(' · ')
  }
  // `decisionLogRead`: the decisions on screen are real; `canCurate` gates every editing control. Both server-set.
  let DECISION_LOG = [],
    decisionLog = replay([]),
    decisionLogRead = false,
    canCurate = false
  const applyDecisionLog = (entries) => {
    DECISION_LOG = entries
    decisionLog = replay(entries)
  }
  // Read-only view for the UI; asOfDate hides exclusions that have since been revoked.
  const EXCLUDED = new Proxy({}, { get: (_, k) => asOfDate(decisionLog.excluded[k]) })

  // UI gating only — the refusal lives server-side. An unreachable decision log reads as "not a curator".
  async function loadDecisionLog() {
    const got = await fetchExceptions()
    applyDecisionLog(got?.entries || [])
    decisionLogRead = got !== null
    canCurate = got?.mayCurate === true
  }

  // The one write path for curated decisions.
  async function record(entry) {
    applyDecisionLog([...DECISION_LOG, await appendException(entry)])
  }
  const cellsOf = (u, asOf) => evaluate(u, decisionLog, asOf)
  const segmentOf = (u, asOf) => segmentFor(u, decisionLog, asOf)
  const I = {
    ok: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
    bad: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    dev: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5 19 6v5.5c0 4-2.9 7.4-7 8.9-4.1-1.5-7-4.9-7-8.9V6l7-2.5Z"/></svg>',
    unk: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7.5" stroke-dasharray="3 2.6"/></svg>',
    na: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M7 12h10"/></svg>',
  }
  const TICK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>'
  // Everything renders via innerHTML; curator-typed decisionLog fields (ref/reason/author) reach every reader.
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => ESC[ch])
  // Drop the trailing parenthetical qualifier in table cells — the panel carries the detail.
  const short = (t) => String(t).replace(/\s*\([^)]*\)\s*$/, '')
  const cellText = (c) =>
    c.s === 'dev'
      ? c.audit?.ref
        ? `${c.v} · ${c.audit.ref}`
        : `${c.v} · approved`
      : c.s === 'ok' || c.s === 'bad'
        ? c.v
        : c.s === 'na'
          ? 'n/a'
          : 'Not scanned'

  const state = defaultState()

  function multi(node, name, values, sel, counts) {
    node.innerHTML = `
      <button class="ms-btn" type="button" aria-haspopup="listbox" aria-expanded="false"
        aria-label="${name}${sel.size ? `, ${sel.size} selected` : ''}">
        <span aria-hidden="true">${name}</span><span class="ms-count"${sel.size ? '' : ' hidden'} aria-hidden="true">${sel.size}</span><span class="car"></span></button>
      <div class="ms-panel" role="listbox" aria-multiselectable="true">
        ${values
          .map(
            (v) => `<div class="ms-opt" role="option" data-v="${esc(v)}" aria-selected="${sel.has(v)}">
            <span class="ms-box">${TICK}</span>${esc(v)}<span class="cnt">${counts[v] || 0}</span></div>`,
          )
          .join('')}
        <button class="ms-clear" type="button">Clear selection</button></div>`
    node.querySelector('.ms-btn').onclick = () => {
      const open = !node.classList.contains('open')
      root.querySelectorAll('.ms.open').forEach((m) => m.classList.remove('open'))
      node.classList.toggle('open', open)
      node.querySelector('.ms-btn').setAttribute('aria-expanded', String(open))
    }
    node.querySelectorAll('.ms-opt').forEach((o) => {
      o.onclick = () => {
        if (sel.has(o.dataset.v)) sel.delete(o.dataset.v)
        else sel.add(o.dataset.v)
        render(node.id)
        writeUrl()
      }
    })
    node.querySelector('.ms-clear').onclick = () => {
      sel.clear()
      render(node.id)
      writeUrl()
    }
  }
  on(document, 'click', (e) => {
    if (!inside(e).closest('.ms')) root.querySelectorAll('.ms.open').forEach((m) => m.classList.remove('open'))
  })

  // Same predicate for every night, so the charts show the history of exactly what the table shows.
  // ownerless rows get a selectable label — a raw undefined stringified to a filter option that
  // could never match (`state.owner.has(undefined-the-string)` vs undefined-the-value)
  const ownerLabel = (u) => u.owner || '(no owner)'
  function passes(u, asOf) {
    if (!state.segments.has(segmentOf(u, asOf))) return false
    if (state.type.size && !state.type.has(u.type)) return false
    if (state.owner.size && !state.owner.has(ownerLabel(u))) return false
    if (state.q && !`${u.repository} ${u.inventoryName || ''}`.toLowerCase().includes(state.q.toLowerCase())) return false
    const cs = cellsOf(u, asOf)
    if (state.filter === 'dev' && !cs.some((c) => c.s === 'bad')) return false
    if (state.filter === 'unk' && !cs.some((c) => c.s === 'unk')) return false
    return true
  }
  const visible = () => DATA.filter((u) => passes(u))

  function rowHtml(u) {
    const cs = cellsOf(u),
      t = totalOf(cs)
    const w = (n) => (t.of ? (n / t.of) * 100 : 0)
    const q = (s) => cs.filter((c) => c.s === s).length
    const seg = (s, col) => (q(s) ? `<i style="width:${w(q(s))}%;background:${col}"></i>` : '')
    return `<tr tabindex="0" role="button" aria-haspopup="dialog" data-repo="${esc(u.repository)}" aria-expanded="false">
      <td><div class="nm" title="${esc(u.repository)}${u.inventoryName ? ` — inventory: ${esc(u.inventoryName)}` : ''}">${esc(u.repository)}</div><div class="sub2"><span class="kind">${u.type}</span>${u.archived ? '<span class="arch">archived</span>' : ''}${EXCLUDED[u.repository] ? `<span class="arch excl" title="${esc(auditLine(EXCLUDED[u.repository])) || 'Excluded from the Golden Path'}">excluded</span>` : ''}${u.owner ? `<span class="owner">${esc(u.owner)}</span>` : '<span class="owner">no owner</span>'}
        </div></td>
      ${cs.map((c) => `<td><span class="chip ${c.s}" title="${esc((c.reason || (c.spec ? 'Expected ' + c.spec : '')) + (c.v ? ' — found ' + c.v : ''))}">${I[c.s]}<span class="t">${esc(short(cellText(c)))}</span></span></td>`).join('')}
      <td><div class="total">${
        t.of
          ? `<span class="v ${t.met === t.of ? 'perfect' : 'bad'}"><b>${t.met}</b>/${t.of}</span>
           <span class="rowbar">${seg('ok', 'var(--ok)')}${seg('dev', 'var(--dev)')}${seg('bad', 'var(--bad)')}</span>`
          : '<span class="v" style="color:var(--na)">not assessed</span>'
      }</div></td></tr>`
  }

  function render(keepOpen) {
    const rows = visible()
      .slice()
      .sort((a, b) => {
        const x = totalOf(cellsOf(a)),
          y = totalOf(cellsOf(b))
        return (x.of ? x.met / x.of : 1) - (y.of ? y.met / y.of : 1) || a.repository.localeCompare(b.repository)
      })
    const all = rows.map((u) => cellsOf(u))

    const openDev = all.reduce((n, cs) => n + cs.filter((c) => c.s === 'bad').length, 0)
    const approved = all.reduce((n, cs) => n + cs.filter((c) => c.s === 'dev').length, 0)
    const unscanned = all.reduce((n, cs) => n + cs.filter((c) => c.s === 'unk').length, 0)
    $id('summary').innerHTML = `
      <div class="st"><div class="n">${rows.length}</div><div class="l">Components shown</div>
        <div class="track"><i style="width:${(rows.length / DATA.length) * 100}%;background:var(--acc)"></i></div></div>
      <div class="st"><div class="n bad">${openDev}</div><div class="l">Open deviations</div>
        <div class="track"><i style="width:${Math.min(100, openDev * 6)}%;background:var(--bad)"></i></div></div>
      <div class="st"><div class="n dev">${approved}</div><div class="l">Approved deviations</div>
        <div class="track"><i style="width:${Math.min(100, approved * 25)}%;background:var(--dev)"></i></div></div>
      <div class="st"><div class="n">${unscanned}</div><div class="l">Checks not scanned</div>
        <div class="track"><i style="width:${Math.min(100, unscanned * 1.4)}%;background:var(--unk)"></i></div></div>`

    // Header meter and figure share one denominator (applicable cells) so they can never disagree.
    const head = CHECKS.map((c, i) => {
      const col = all.map((cs) => cs[i])
      const app = col.filter((x) => x.s !== 'na')
      const n = app.length
      const cnt = (s) => app.filter((x) => x.s === s).length
      const good = cnt('ok') + cnt('dev')
      const seg = (s, col2) => (cnt(s) ? `<i style="width:${(cnt(s) / n) * 100}%;background:${col2}"></i>` : '')
      const specs = [...new Set(rows.map((u) => (RULES[u.type] || {})[c.k]).filter(Boolean))]
      const rate = !n
        ? `<span class="ck-rate off">not applicable</span><span class="ck-gap"></span>`
        : !COLLECTED[c.k]
          ? `<span class="ck-rate off">not collected</span><span class="ck-gap">${n} applicable</span>`
          : `<span class="ck-rate${good / n < 0.6 ? ' warn' : ''}"><b>${good}/${n}</b> conform</span>
           <span class="ck-gap">${cnt('unk') ? cnt('unk') + ' not scanned' : ''}</span>`
      return `<th><span class="ck-name">${c.name}</span><span class="ck-spec">${specs.join(' · ') || '—'}</span>
        <span class="meter">${seg('ok', 'var(--ok)')}${seg('dev', 'var(--dev)')}${seg('bad', 'var(--bad)')}</span>${rate}</th>`
    }).join('')

    let body
    if (!rows.length) {
      body = `<tr><td colspan="${CHECKS.length + 2}" style="padding:40px;text-align:center;color:var(--faint)">${
        state.segments.size
          ? 'No components match these filters. Clear a filter or switch back to All.'
          : 'No group of repositories is selected. Pick one under Repositories shown in Settings.'
      }</td></tr>`
    } else if (state.group) {
      const groups = {}
      for (const u of rows) (groups[u.owner || 'No owner'] ||= []).push(u)
      body = Object.keys(groups)
        .sort()
        .map((o) => {
          const items = groups[o]
          const bad = items.reduce((n, u) => n + cellsOf(u).filter((c) => c.s === 'bad').length, 0)
          const tot = items.reduce(
            (acc, u) => {
              const t = totalOf(cellsOf(u))
              acc.met += t.met
              acc.of += t.of
              return acc
            },
            { met: 0, of: 0 },
          )
          return (
            `<tr class="grp"><td colspan="${CHECKS.length + 2}"><span class="g">${esc(o)}</span>
          <span class="gm">${items.length} component${items.length > 1 ? 's' : ''} · ${tot.met}/${tot.of} checks met · ${bad} deviation${bad === 1 ? '' : 's'}</span></td></tr>` +
            items.map(rowHtml).join('')
          )
        })
        .join('')
    } else {
      body = rows.map(rowHtml).join('')
    }

    $id('tbl').innerHTML = `<colgroup><col class="c-name">${CHECKS.map(() => '<col class="c-check">').join('')}<col class="c-total"></colgroup>
       <thead><tr><th><span class="ck-name">Component</span><span class="ck-spec">${rows.length} shown of ${DATA.length}</span></th>
        ${head}<th><span class="ck-name">Checks met</span><span class="ck-spec">of applicable</span></th></tr></thead>
       <tbody>${body}</tbody>`

    renderSegments()
    // Type/Owner count inside the chosen segments; segment counts stay absolute.
    const inSeg = DATA.filter((u) => state.segments.has(segmentOf(u)))
    const count = (f) =>
      inSeg.reduce((m, u) => {
        for (const v of f(u)) m[v] = (m[v] || 0) + 1
        return m
      }, {})
    const values = (f) => [...new Set(inSeg.flatMap(f))].sort()
    multi(
      $id('ms-type'),
      'Type',
      values((u) => [u.type]),
      state.type,
      count((u) => [u.type]),
    )
    multi(
      $id('ms-owner'),
      'Owner',
      values((u) => [ownerLabel(u)]),
      state.owner,
      count((u) => [ownerLabel(u)]),
    )
    if (keepOpen) {
      const n = $id(keepOpen)
      if (n) {
        n.classList.add('open')
        n.querySelector('.ms-btn').setAttribute('aria-expanded', 'true')
      }
    }
    const list = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
    const chosen = SEGMENTS.filter((g) => state.segments.has(g.k))
    const left = SEGMENTS.reduce((n, g) => n + (state.segments.has(g.k) ? 0 : segCounts[g.k] || 0), 0)
    $id('hidden-note').textContent =
      (!chosen.length
        ? 'No group selected'
        : chosen.length === SEGMENTS.length
          ? 'Every repository in the organisation'
          : `Showing ${list(chosen.map((g) => g.label.toLowerCase()))}`) + (left ? ` · ${left} not shown` : '')
  }

  // Rebuilt every render: a curated exclusion moves a repository from one group to another.
  let segCounts = {}
  function renderSegments() {
    segCounts = segmentCounts(DATA, decisionLog)
    const all = state.segments.size === SEGMENTS.length
    const some = state.segments.size > 0 && !all
    const row = (id, cls, checked, label, hint, n) => `
      <label class="set${cls}"><input type="checkbox" data-seg="${id}"${checked ? ' checked' : ''}>
        <span>${label}${hint ? `<small>${hint}</small>` : ''}</span><span class="n">${n}</span></label>`
    $id('segments').innerHTML =
      row('*', ' all', all, 'All repositories', '', DATA.length) +
      SEGMENTS.map((g) => row(g.k, '', state.segments.has(g.k), g.label, g.hint, segCounts[g.k] || 0)).join('')

    const box = root.querySelector('#segments input[data-seg="*"]')
    box.indeterminate = some
    $id('segments').onchange = (e) => {
      const k = e.target.dataset.seg
      if (k === '*') {
        if (e.target.checked) SEGMENTS.forEach((g) => state.segments.add(g.k))
        else state.segments.clear()
      } else if (e.target.checked) state.segments.add(k)
      else state.segments.delete(k)
      state.type.clear()
      state.owner.clear()
      render('settings')
      writeUrl()
      // The list was rebuilt, so re-focus the (new) checkbox element for keyboard readers.
      root.querySelector(`#segments input[data-seg="${k}"]`)?.focus()
    }
  }

  const THEME_KEY = 'gp-theme'
  function setTheme(v) {
    if (v === 'system') {
      hostEl.removeAttribute('data-theme')
      localStorage.removeItem(THEME_KEY)
    } else {
      hostEl.setAttribute('data-theme', v)
      localStorage.setItem(THEME_KEY, v)
    }
    root.querySelectorAll('#theme button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === v)))
  }
  setTheme(localStorage.getItem(THEME_KEY) || 'system')
  $id('theme').onclick = (e) => {
    const b = e.target.closest('button')
    if (b) setTheme(b.dataset.t)
  }

  // ── Details ─────────────────────────────────────────────────────────────────────────
  let lastRow = null,
    current = null,
    foldOpen = false,
    editing = null

  // Screen-reader announcement for panel changes that do not move focus (j/k traversal).
  const announce = (msg) => {
    let n = $id('live')
    if (!n) {
      n = document.createElement('div')
      n.id = 'live'
      n.setAttribute('aria-live', 'polite')
      n.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap'
      root.appendChild(n)
    }
    n.textContent = msg
  }
  const toast = (msg) => {
    const t = $id('toast')
    t.textContent = msg
    t.classList.add('on')
    clearTimeout(toast._t)
    toast._t = setTimeout(() => t.classList.remove('on'), 2600)
  }
  const stateWord = (c) => (c.s === 'dev' ? 'Approved' : c.s === 'ok' ? 'Conforms' : c.s === 'bad' ? 'Deviation' : c.s === 'na' ? 'n/a' : 'Not scanned')

  // Which decisions a cell can move to; non-curators get none but still see what was decided.
  function movesFor(c) {
    if (!canCurate) return []
    if (c.s === 'bad')
      return [
        { v: 'deviation', label: 'Approve deviation', hint: 'Divergence is accepted; counts as met.' },
        { v: 'not-applicable', label: 'Not applicable', hint: 'The rule does not apply here; leaves the total.' },
      ]
    if (c.s === 'unk') return [{ v: 'not-applicable', label: 'Not applicable', hint: 'The rule does not apply here; leaves the total.' }]
    if (c.s === 'dev') return [{ v: 'revoke', label: 'Remove approval', hint: 'Back to an open deviation.' }]
    if (c.s === 'na' && c.curated) return [{ v: 'revoke', label: 'Remove exemption', hint: 'Back into the total.' }]
    return []
  }

  function rowEditor(c, i) {
    const moves = movesFor(c)
    return `<div class="rowedit" id="rowedit">
      <div class="moves">
        ${moves
          .map(
            (m, n) => `<label class="move">
          <input type="radio" name="f-move" value="${m.v}" ${n === 0 ? 'checked' : ''}>
          <span><b>${m.label}</b><small>${m.hint}</small></span></label>`,
          )
          .join('')}
      </div>
      <label for="f-ref">Decision reference <span class="opt">optional</span></label>
      <input id="f-ref" placeholder="Ticket, document or meeting note" autocomplete="off">
      <label for="f-why">Reason <span class="opt">optional</span></label>
      <textarea id="f-why" placeholder="Why this decision was taken"></textarea>
      <div class="btnrow">
        <button class="btn primary" type="button" id="f-save" data-i="${i}">Save</button>
        <button class="btn" type="button" id="f-cancel">Cancel</button>
      </div>
    </div>`
  }

  function checkRow(c, i) {
    const spec = c.excluded ? 'Not assessed' : !c.spec ? c.reason : c.s === 'ok' ? c.v : c.v ? `${c.v} · expected ${c.spec}` : `Expected ${c.spec}`
    const trail = auditLine(c.audit)
    const moves = movesFor(c)
    const open = editing === i
    return `<div class="d-row ${open ? 'editing' : ''}">
        <span class="d-lbl">${CHECKS[i].name}<small>${esc(spec)}</small>${trail ? `<small class="trail">${esc(trail)}</small>` : ''}</span>
        <span class="d-state">
          <span class="chip ${c.s}">${I[c.s]}${stateWord(c)}</span>
          ${moves.length ? `<button class="change" type="button" data-edit="${i}" aria-expanded="${open}">${open ? 'Close' : 'Change'}</button>` : ''}
        </span>
      </div>${open ? rowEditor(c, i) : ''}`
  }

  function drawerBody() {
    const u = current,
      cs = cellsOf(u)
    const excluded = !!EXCLUDED[u.repository]
    const all = cs.map((c, i) => ({ c, i }))
    // Not-collected stays in the open list (a gap to close); not-applicable folds away (settled).
    const folded = excluded ? [] : all.filter(({ c }) => c.s === 'na')
    const shown = excluded ? all : all.filter(({ c }) => c.s !== 'na')
    const contact = u.contact

    return `
      ${excluded ? `<p class="d-note" style="margin-top:16px">Excluded from the Golden Path — nothing here counts towards any figure on this page.${auditLine(EXCLUDED[u.repository]) ? `<br><span style="color:var(--faint)">${esc(auditLine(EXCLUDED[u.repository]))}</span>` : ''}</p>` : ''}
      <p class="d-title">Checks</p>
      ${shown.map(({ c, i }) => checkRow(c, i)).join('')}
      ${
        folded.length
          ? `
        <button class="d-fold" id="d-fold" aria-expanded="${foldOpen}" aria-controls="d-na">
          <span class="car"></span>${folded.length} not applicable to a ${u.type.toLowerCase()}</button>
        <div id="d-na" ${foldOpen ? '' : 'hidden'}>${folded.map(({ c, i }) => checkRow(c, i)).join('')}</div>`
          : ''
      }

      <p class="d-title">Ownership</p>
      <div class="facts">
        <div><dt>Team</dt><dd>${u.owner ? esc(u.owner) : 'Not set'}</dd></div>
        <div><dt>Technical contact</dt><dd>${contact ? esc(contact) : 'Not set'}</dd></div>
      </div>

      ${
        canCurate
          ? `<div class="curated">
        <div class="btnrow" style="margin-top:0">
          ${
            excluded
              ? '<button class="btn" type="button" id="unexclude">Remove exclusion</button>'
              : '<button class="btn" type="button" id="exclude-all">Exclude whole component</button>'
          }
        </div>
        <div id="formhost"></div>
      </div>`
          : ''
      }`
  }

  const FORMS = {
    exclude: { title: 'Exclude whole component', why: 'Why the Golden Path does not apply to this component at all' },
    revoke: { title: 'Remove exclusion', why: 'Why this component comes back into scope' },
  }
  function formHtml(kind) {
    const u = current,
      cs = cellsOf(u),
      f = FORMS[kind]
    const opts = f.pick ? CHECKS.map((c, i) => ({ c, i })).filter(({ i }) => f.pick(cs[i])) : null
    return `<div class="form">
      <p class="form-h">${f.title}</p>
      ${
        opts
          ? `<label for="fx-check">Check</label>
        <select id="fx-check" aria-describedby="fx-err">
          <option value="" selected>Choose a check…</option>
          ${opts.map(({ c, i }) => `<option value="${i}">${c.name} — ${cs[i].v ? esc(cs[i].v) : 'not scanned'}</option>`).join('')}</select>`
          : ''
      }
      <label for="fx-ref">Decision reference <span class="opt">optional</span></label>
      <input id="fx-ref" placeholder="Ticket, document or meeting note" autocomplete="off">
      <label for="fx-why">Reason <span class="opt">optional</span></label>
      <textarea id="fx-why" placeholder="${f.why}"></textarea>
      <div class="err" id="fx-err" role="alert" hidden></div>
      <div class="btnrow">
        <button class="btn primary" type="button" id="fx-save">Save</button>
        <button class="btn" type="button" id="fx-cancel">Cancel</button>
      </div>
    </div>`
  }

  const TYPE_OF = { exclude: 'exclusion', revoke: 'revoke' }
  const DONE_MSG = { exclude: 'Component excluded', revoke: 'Exclusion removed' }

  function mountForm(kind) {
    const host = $id('formhost')
    host.innerHTML = formHtml(kind)
    // The form mounts at the bottom of a scrolling sheet — bring it into view.
    host.scrollIntoView({ block: 'end', behavior: 'smooth' })
    host.querySelector('#fx-cancel').onclick = () => {
      host.innerHTML = ''
    }
    host.querySelector('#fx-save').onclick = () => {
      const u = current
      const check = host.querySelector('#fx-check')
      const err = host.querySelector('#fx-err')
      // Only WHICH check is required; who and when are recorded server-side from the session.
      if (check && !check.value) {
        err.textContent = 'Choose which check this applies to.'
        err.hidden = false
        check.setAttribute('aria-invalid', 'true')
        check.focus()
        err.scrollIntoView({ block: 'center', behavior: 'smooth' })
        return
      }
      err.hidden = true
      save(
        {
          type: TYPE_OF[kind],
          component: u.repository,
          ...(check ? { check: CHECKS[+check.value].k } : {}),
          ref: host.querySelector('#fx-ref').value.trim(),
          reason: host.querySelector('#fx-why').value.trim(),
        },
        DONE_MSG[kind],
        host,
      )
    }
    ;(host.querySelector('#fx-check') || host.querySelector('#fx-ref')).focus()
  }

  // A decision is either recorded or it is not — no "kept on this page only" state.
  async function save(entry, okMsg, host) {
    const repo = entry.component
    try {
      await record(entry)
    } catch (e) {
      const err = host?.querySelector('#f-err')
      if (err) {
        err.textContent = e.message
        err.hidden = false
        err.scrollIntoView({ block: 'center' })
      } else toast(e.message)
      return
    }
    render()
    openDetails(repo, { keepScroll: true })
    toast(`${okMsg} — written to the decision log`)
  }

  function siblings() {
    return [...root.querySelectorAll('tbody tr[data-repo]')].map((t) => t.dataset.repo)
  }

  function openDetails(repo, opts = {}) {
    const u = DATA.find((x) => x.repository === repo)
    if (!u) return
    current = u
    if (!opts.keepScroll) {
      foldOpen = false
      editing = null
    }
    const cs = cellsOf(u),
      t = totalOf(cs)
    const unk = cs.filter((c) => c.s === 'unk').length
    $id('d-name').textContent = u.repository
    const list0 = siblings(),
      pos = list0.indexOf(repo)
    $id('d-sub').innerHTML =
      `<span class="kind">${u.type}</span>${u.archived ? '<span class="arch">archived</span>' : ''}` +
      `${u.status ? `<span>${esc(u.status)}</span>` : ''}` +
      (t.of
        ? `<span><b style="color:var(--ink)">${t.met} of ${t.of}</b> applicable checks met${unk ? ` · ${unk} not collected` : ''}</span>`
        : '<span>Not assessed</span>') +
      (pos > -1 ? `<span>${pos + 1} of ${list0.length}</span>` : '')
    $id('d-apps').textContent = u.applications.length ? u.applications.join(' · ') : 'Not linked to an application'
    $id('d-links').innerHTML = `
      ${REPO_URL(u.repository) ? `<a class="iconlink" href="${esc(REPO_URL(u.repository))}" target="_blank" rel="noopener" title="Open ${esc(u.repository)} on GitHub" aria-label="Open ${esc(u.repository)} on GitHub">${GH}</a>` : ''}
      <a class="iconlink" href="${MAP_URL}?sel=${encodeURIComponent(u.repository)}" target="_blank" rel="noopener" title="Show ${esc(u.repository)} in the Architecture Map" aria-label="Show ${esc(u.repository)} in the Architecture Map">${MAPI}</a>`
    $id('d-body').innerHTML = drawerBody()

    const list = siblings(),
      i = list.indexOf(repo)
    const prev = $id('d-prev'),
      next = $id('d-next')
    prev.disabled = i <= 0
    next.disabled = i < 0 || i >= list.length - 1
    prev.onclick = () => openDetails(list[i - 1])
    next.onclick = () => openDetails(list[i + 1])

    const fold = $id('d-fold')
    if (fold)
      fold.onclick = () => {
        foldOpen = !foldOpen
        openDetails(repo, { keepScroll: true })
      }
    root.querySelectorAll('#d-body [data-edit]').forEach((b) => {
      b.onclick = () => {
        editing = editing === +b.dataset.edit ? null : +b.dataset.edit
        openDetails(repo, { keepScroll: true })
      }
    })
    const ed = $id('rowedit')
    if (ed) {
      ed.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      ed.querySelector('#f-cancel').onclick = () => {
        editing = null
        openDetails(repo, { keepScroll: true })
      }
      ed.querySelector('#f-save').onclick = () => {
        const i = +ed.querySelector('#f-save').dataset.i
        const type = ed.querySelector('input[name="f-move"]:checked').value
        const done = { deviation: 'Deviation approved', 'not-applicable': 'Marked not applicable', revoke: 'Decision removed' }[type]
        editing = null
        save(
          { type, component: u.repository, check: CHECKS[i].k, ref: ed.querySelector('#f-ref').value.trim(), reason: ed.querySelector('#f-why').value.trim() },
          done,
          ed,
        )
      }
    }
    $id('unexclude')?.addEventListener('click', () => mountForm('revoke'))
    $id('exclude-all')?.addEventListener('click', () => mountForm('exclude'))

    root.querySelectorAll('tbody tr[data-repo]').forEach((tr) => tr.setAttribute('aria-expanded', String(tr.dataset.repo === repo)))
    lastRow = root.querySelector(`tbody tr[data-repo="${CSS.escape(repo)}"]`) || lastRow

    const d = $id('drawer')
    const wasOpen = d.classList.contains('open')
    d.classList.add('open')
    d.setAttribute('aria-hidden', 'false')
    if (!wasOpen) $id('d-name').focus()
    else announce(`${u.repository}, ${t.of ? `${t.met} of ${t.of} checks met` : 'not assessed'}`)
    // Stepping through components replaces the entry; only a fresh open pushes, so Back leaves the panel.
    if (history.state?.component !== repo) writeUrl({ push: !wasOpen, repo })
    lastRow?.scrollIntoView({ block: 'nearest' })
  }

  function closeDetails(fromPop) {
    if (!$id('drawer').classList.contains('open')) return
    current = null
    $id('drawer').classList.remove('open')
    $id('drawer').setAttribute('aria-hidden', 'true')
    root.querySelectorAll('tbody tr[data-repo]').forEach((tr) => tr.setAttribute('aria-expanded', 'false'))
    if (lastRow && root.contains(lastRow)) lastRow.focus()
    if (!fromPop) writeUrl({ push: true })
  }
  // First Escape cancels a dirty form; only the next one closes the panel. The row editor (f-*)
  // and the exclusion form (fx-*) can be open at once — cancel the one that is actually dirty.
  function dirtyCancel() {
    for (const p of ['f', 'fx']) {
      const w = $id(`${p}-why`),
        r = $id(`${p}-ref`)
      if ((w && w.value.trim()) || (r && r.value.trim())) return $id(`${p}-cancel`)
    }
    return null
  }
  function escapeOnce() {
    const cancel = dirtyCancel()
    if (cancel) {
      cancel.click()
      toast('Form discarded — press Escape again to close')
      return
    }
    closeDetails()
  }
  // Non-modal, no scrim: bare-space click closes, another row switches, a control does neither.
  on(document, 'mousedown', (e) => {
    if (!$id('drawer').classList.contains('open')) return
    if (inside(e).closest('#drawer, tr[data-repo], button, a, input, select, textarea, label, .ms')) return
    escapeOnce()
  })
  $id('d-close').onclick = () => escapeOnce()
  // Restore the whole view before the panel — openDetails would otherwise overwrite the entry being restored.
  on(window, 'popstate', (e) => {
    readUrl()
    syncControls()
    render()
    setTab(state.tab)
    if (e.state?.component) openDetails(e.state.component)
    else closeDetails(true)
  })

  on(document, 'keydown', (e) => {
    const open = $id('drawer').classList.contains('open')
    if (!open) return
    if (e.key === 'Escape') {
      escapeOnce()
      return
    }
    if (root.activeElement?.matches('input, textarea, select')) return
    const list = siblings(),
      i = list.indexOf(current?.repository)
    if ((e.key === 'j' || e.key === 'ArrowDown') && i > -1 && i < list.length - 1) {
      e.preventDefault()
      openDetails(list[i + 1])
    }
    if ((e.key === 'k' || e.key === 'ArrowUp') && i > 0) {
      e.preventDefault()
      openDetails(list[i - 1])
    }
  })
  $id('tbl').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-repo]')
    if (!tr) return
    lastRow = tr
    openDetails(tr.dataset.repo)
  })
  $id('tbl').addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr[data-repo]')
    if (!tr) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      lastRow = tr
      openDetails(tr.dataset.repo)
    }
  })

  $id('seg').onclick = (e) => {
    const b = e.target.closest('button')
    if (!b) return
    state.filter = b.dataset.f
    root.querySelectorAll('#seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
    render()
    writeUrl()
  }
  $id('grp').onchange = (e) => {
    state.group = e.target.checked
    render('settings')
    writeUrl()
  }
  const setNode = $id('settings')
  setNode.querySelector('.ms-btn').onclick = () => {
    const open = !setNode.classList.contains('open')
    root.querySelectorAll('.ms.open').forEach((m) => m.classList.remove('open'))
    setNode.classList.toggle('open', open)
    setNode.querySelector('.ms-btn').setAttribute('aria-expanded', String(open))
  }
  $id('q').oninput = (e) => {
    state.q = e.target.value
    render()
    writeUrl()
  }
  // ── Analytics ───────────────────────────────────────────────────────────────────────
  // Filters apply to the whole series, so the charts are the history of exactly what the table shows.
  const STATE_COLOR = { ok: 'var(--c-ok)', dev: 'var(--c-dev)', bad: 'var(--c-bad)', unk: 'var(--unk)' }
  const STATE_LABEL = { ok: 'Conforming', dev: 'Approved deviation', bad: 'Open deviation', unk: 'Not scanned' }

  // ── the trend chart ─────────────────────────────────────────────────────────────────
  // Both charts read one per-night stat so they can never tell two stories about the same evening.
  let statsCache = new Map()
  function statsOn(night) {
    let hit = statsCache.get(night.d)
    if (!hit) statsCache.set(night.d, (hit = statsFor(night, { decisionLog, keep: passes })))
    return hit
  }

  const tip = $id('tip')
  const showTip = (html, x, y) => {
    tip.innerHTML = html
    tip.classList.add('on')
    const r = tip.getBoundingClientRect()
    tip.style.left = Math.min(window.innerWidth - r.width - 12, Math.max(12, x - r.width / 2)) + 'px'
    tip.style.top = Math.max(12, y - r.height - 12) + 'px'
  }
  const hideTip = () => tip.classList.remove('on')

  const svg = (w, h, body, label) => `<svg viewBox="0 0 ${w} ${h}" role="img" style="max-width:${w}px"${label ? ` aria-label="${label}"` : ''}>${body}</svg>`
  const legend = (keys) =>
    `<div class="legend-row">${keys
      .map(
        (k) =>
          `<span><svg class="swatch" viewBox="0 0 16 8" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4"
       stroke="${STATE_COLOR[k]}" stroke-width="2" stroke-linecap="round"${k === 'unk' ? ' stroke-dasharray="4 3"' : ''}/></svg>${STATE_LABEL[k]}</span>`,
      )
      .join('')}</div>`

  const DAY = 864e5
  const range = { key: 'all', from: 0, to: 0 } // filled from the history once it loads
  let customOpen = false // the fields are a disclosure: closing them keeps the window, hides the form

  // Clamped to the first night on record — an empty left half would read as "nothing happened".
  const RANGES = {
    quarter: { label: 'Quarter', from: () => Math.max(ALL_TIME_FROM, TODAY - 90 * DAY) },
    year: { label: 'Year', from: () => Math.max(ALL_TIME_FROM, TODAY - 365 * DAY) },
    all: { label: 'All time', from: () => ALL_TIME_FROM },
  }
  const iso = (t) => new Date(t).toISOString().slice(0, 10)
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  // A night the pipeline did not run is simply absent — the line joins its neighbours, no invented point.
  const nightsIn = (from, to) => HISTORY.filter((n) => n.t >= from && n.t <= to)
  const dailySeries = (from, to) => nightsIn(from, to).map(statsOn)

  // Bucket size keeps the plotted point count roughly constant across window sizes.
  const bucketDays = (span) => (span < 100 ? 1 : span <= 400 ? 7 : 30)
  function resample(daily, days) {
    if (days === 1) return daily.map((d) => ({ ...d, from: d.t, to: d.t }))
    const out = []
    for (let i = 0; i < daily.length; i += days) {
      const chunk = daily.slice(i, i + days)
      const mean = (k) => Math.round(chunk.reduce((s, d) => s + d[k], 0) / chunk.length)
      out.push({
        t: chunk[Math.floor(chunk.length / 2)].t,
        from: chunk[0].t,
        to: chunk[chunk.length - 1].t,
        ok: mean('ok'),
        dev: mean('dev'),
        bad: mean('bad'),
        unk: mean('unk'),
        n: chunk.length,
      })
    }
    // The last point is today, not the middle of a half-finished bucket.
    const lastDay = daily[daily.length - 1]
    Object.assign(out[out.length - 1], { t: lastDay.t, to: lastDay.t, ok: lastDay.ok, dev: lastDay.dev, bad: lastDay.bad, unk: lastDay.unk })
    return out
  }

  // Ticks follow the span, not the range name.
  function ticksFor(from, to) {
    const span = (to - from) / DAY
    const out = []
    const push = (t, label) => out.push({ t, label })
    if (span < 14) {
      for (let d = from; d <= to; d += DAY) push(d, new Date(d).getUTCDate() + ' ' + MONTHS[new Date(d).getUTCMonth()])
    } else if (span <= 100) {
      const first = new Date(from)
      first.setUTCDate(first.getUTCDate() + ((8 - first.getUTCDay()) % 7))
      for (let d = first.getTime(); d <= to; d += 7 * DAY) push(d, new Date(d).getUTCDate() + ' ' + MONTHS[new Date(d).getUTCMonth()])
    } else if (span <= 400) {
      const c = new Date(Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth() + 1, 1))
      while (c.getTime() <= to) {
        push(c.getTime(), MONTHS[c.getUTCMonth()] + (c.getUTCMonth() === 0 ? ' ’' + String(c.getUTCFullYear()).slice(2) : ''))
        c.setUTCMonth(c.getUTCMonth() + 1)
      }
    } else {
      // Label the opening year at the left edge when the window starts far from 1 January.
      const firstJan = Date.UTC(new Date(from).getUTCFullYear() + 1, 0, 1)
      if (firstJan - from > 45 * DAY) push(from, String(new Date(from).getUTCFullYear()))
      const c = new Date(firstJan)
      while (c.getTime() <= to) {
        push(c.getTime(), String(c.getUTCFullYear()))
        c.setUTCFullYear(c.getUTCFullYear() + 1)
      }
    }
    return out
  }

  function chartTrend() {
    hideTip()
    const spanDays = (range.to - range.from) / DAY
    const grain = bucketDays(spanDays)
    const host = $id('ch-trend')
    const raw = dailySeries(range.from, range.to)
    if (!raw.length) {
      host.innerHTML = `<h3>Overall state</h3><p class="grain">No nightly run falls inside this window.
        The record starts on ${iso(ALL_TIME_FROM)}.</p>`
      return
    }
    const data = resample(raw, grain)
    const W = Math.max(700, Math.round(host.clientWidth - 40)),
      H = 300
    const P = { l: 34, r: 46, t: 12, b: 26 }
    const series = ['ok', 'dev', 'bad', 'unk']
    const max = Math.max(...data.flatMap((d) => series.map((k) => d[k])))
    const top = Math.max(25, Math.ceil(max / 25) * 25)
    const x = (t) => P.l + ((t - range.from) / (range.to - range.from || 1)) * (W - P.l - P.r)
    const y = (v) => H - P.b - (v / top) * (H - P.t - P.b)

    const steps = Array.from({ length: top / 25 + 1 }, (_, i) => i * 25)
    const grid = steps.map((v) => `<line class="gridline" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/>`).join('')
    const yLabels = steps.map((v, i) => `<text class="axis" x="0" y="${y(v) + 3.5}">${v}${i === steps.length - 1 ? ' checks' : ''}</text>`).join('')
    const ticks = ticksFor(range.from, range.to)
      .map((t) => `<text class="axis" x="${x(t.t)}" y="${H - 6}" text-anchor="middle">${t.label}</text>`)
      .join('')

    const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
    const COLOR = { ok: 'var(--c-ok)', dev: 'var(--c-dev)', bad: 'var(--c-bad)', unk: 'var(--unk)' }
    const ends = series.map((k) => ({ k, yv: y(data[data.length - 1][k]), v: data[data.length - 1][k] })).sort((a, b) => a.yv - b.yv)
    for (let i = 1; i < ends.length; i++) if (ends[i].yv - ends[i - 1].yv < 13) ends[i].yv = ends[i - 1].yv + 13
    const paths = series
      .map((k) => {
        const pts = data.map((d) => [x(d.t), y(d[k])])
        const last = pts[pts.length - 1]
        const e = ends.find((n) => n.k === k)
        return `<path d="${line(pts)}" fill="none" stroke="${COLOR[k]}" stroke-width="2" stroke-linejoin="round"
          stroke-linecap="round" ${k === 'unk' ? 'stroke-dasharray="4 4"' : ''}/>
        <circle cx="${last[0]}" cy="${last[1]}" r="4" fill="${COLOR[k]}" stroke="var(--sur)" stroke-width="2"/>
        <text class="axis" x="${last[0] + 9}" y="${e.yv + 4}" fill="${COLOR[k]}">${e.v}</text>`
      })
      .join('')

    host.innerHTML = `
      <h3>Overall state</h3>
      ${legend(['ok', 'dev', 'bad', 'unk'])}
      ${svg(
        W,
        H,
        grid +
          yLabels +
          paths +
          `<line class="gridline" x1="${P.l}" x2="${W - P.r}" y1="${y(0)}" y2="${y(0)}"/>` +
          ticks +
          `<line id="xhair" x1="0" x2="0" y1="${P.t}" y2="${H - P.b}" stroke="var(--ink)" stroke-width="1" opacity="0"/>
         <rect id="hit" x="${P.l}" y="${P.t}" width="${W - P.l - P.r}" height="${H - P.t - P.b}" fill="transparent"/>`,
        `Checks by state over the selected window. Today: ${series.map((k) => `${STATE_LABEL[k]} ${data[data.length - 1][k]}`).join(', ')}.`,
      )}`

    // One overlay rect, not per-point hits — at daily resolution a per-point target is 1px wide.
    // Measure the plot's svg via the overlay: the legend swatches are the panel's first SVGs.
    const hit = host.querySelector('#hit'),
      svgEl = hit.closest('svg'),
      xh = host.querySelector('#xhair')
    hit.onmousemove = (e) => {
      const box = svgEl.getBoundingClientRect()
      const px = ((e.clientX - box.left) / box.width) * W
      const t = range.from + ((px - P.l) / (W - P.l - P.r)) * (range.to - range.from)
      const d = data.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a))
      xh.setAttribute('x1', x(d.t))
      xh.setAttribute('x2', x(d.t))
      xh.setAttribute('opacity', '.25')
      const f = new Date(d.from),
        l = new Date(d.to)
      const fmt = (x) => `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`
      const head =
        grain === 1
          ? `${fmt(f)} ${f.getUTCFullYear()}`
          : `${fmt(f)} – ${fmt(l)} ${l.getUTCFullYear()} <span style="opacity:.6">· ${grain === 7 ? 'weekly' : 'monthly'} mean</span>`
      showTip(
        `<b>${head}</b><br>` +
          series.map((k) => `<i style="background:${COLOR[k]}${k === 'unk' ? ';opacity:.5' : ''}"></i>${STATE_LABEL[k]} <b>${d[k]}</b>`).join('<br>') +
          `<br><span style="opacity:.7">of ${series.reduce((s, k) => s + d[k], 0)} applicable checks</span>`,
        e.clientX,
        box.top + 60,
      )
    }
    hit.onmouseleave = () => {
      xh.setAttribute('opacity', '0')
      hideTip()
    }
  }

  function renderRangeBar() {
    const spanDays = (range.to - range.from) / DAY
    const grain = bucketDays(spanDays)
    const host = $id('rangetop')
    host.innerHTML = `
      <div class="rangetop-row">
        <p class="grain">Showing ${Math.round(spanDays)} days ·
          ${grain === 1 ? 'one point per night' : grain === 7 ? 'weekly means of nightly samples' : 'monthly means of nightly samples'}</p>
        <div class="rangewrap" id="rangebar">
          <div class="rangebar">
            ${Object.entries(RANGES)
              .map(
                ([k, r]) => `<button type="button" data-range="${k}"
              aria-pressed="${range.key === k}">${r.label}</button>`,
              )
              .join('')}
          </div>
          <button class="rangecustom" type="button" data-range="custom"
            aria-pressed="${range.key === 'custom'}" aria-expanded="${customOpen}">Custom<span class="car"></span></button>
        </div>
      </div>
      ${
        range.key === 'custom' && customOpen
          ? `<div class="customrange">
        <label>From <input type="date" id="r-from" value="${iso(range.from)}" max="${iso(range.to)}"></label>
        <label>To <input type="date" id="r-to" value="${iso(range.to)}" min="${iso(range.from)}" max="${iso(TODAY)}"></label>
      </div>`
          : ''
      }`

    const redraw = () => {
      renderRangeBar()
      chartTrend()
      chartChecks()
    }
    host.querySelector('#rangebar').onclick = (e) => {
      const b = e.target.closest('button')
      if (!b) return
      if (b.dataset.range === 'custom') {
        customOpen = range.key === 'custom' ? !customOpen : true // pressing again folds the form away
        range.key = 'custom'
      } else {
        range.key = b.dataset.range
        customOpen = false
        range.from = RANGES[range.key].from()
        range.to = TODAY
      }
      redraw()
      writeUrl()
    }
    const from = host.querySelector('#r-from'),
      to = host.querySelector('#r-to')
    // A cleared field is Date.parse('') = NaN — fall back to the whole record, like readUrl does.
    if (from)
      from.onchange = () => {
        range.from = Date.parse(from.value) || ALL_TIME_FROM
        redraw()
        writeUrl()
      }
    if (to)
      to.onchange = () => {
        range.to = Date.parse(to.value) || TODAY
        redraw()
        writeUrl()
      }
  }

  // ── 2 · small multiples: which rule is not landing ──────────────────────────────────
  // Same window and grain as the trend chart above.
  function chartChecks() {
    const spanDays = (range.to - range.from) / DAY
    const grain = bucketDays(spanDays)
    const host = $id('ch-checks')

    const nights = nightsIn(range.from, range.to).map(statsOn)
    if (!nights.length) {
      host.innerHTML = '<h3>State by rule</h3><p class="grain">No nightly run in this window.</p>'
      return
    }

    const facets = CHECKS.map((c, i) => {
      const now = nights[nights.length - 1].perCheck[i]
      const { applicable, met } = now
      const rate = applicable ? met / applicable : 0
      const daily = nights.map((n) => ({ t: n.t, v: n.perCheck[i].applicable ? n.perCheck[i].met / n.perCheck[i].applicable : 0 }))
      const pts =
        grain === 1
          ? daily
          : (() => {
              const out = []
              for (let k = 0; k < daily.length; k += grain) {
                const chunk = daily.slice(k, k + grain)
                out.push({ t: chunk[Math.floor(chunk.length / 2)].t, v: chunk.reduce((a, b) => a + b.v, 0) / chunk.length })
              }
              out[out.length - 1] = daily[daily.length - 1]
              return out
            })()
      const delta = Math.round((pts[pts.length - 1].v - pts[0].v) * 100)
      return { name: c.name, applicable, met, rate, pts, delta, collected: COLLECTED[c.k] }
    })
    facets.sort((a, b) => (a.collected === b.collected ? a.rate - b.rate : a.collected ? -1 : 1))

    const W = 200,
      H = 58,
      P = { l: 2, r: 2, t: 7, b: 4 }
    // Stroke colour is DIRECTION over the window, not level — green/red already mean conform/deviate here.
    const spark = (f) => {
      const x = (t) => P.l + ((t - range.from) / (range.to - range.from || 1)) * (W - P.l - P.r)
      const y = (v) => H - P.b - (v / 1.08) * (H - P.t - P.b)
      const line = f.pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ')
      const last = f.pts[f.pts.length - 1]
      const tone = f.delta > 0 ? 'var(--c-ok)' : f.delta < 0 ? 'var(--c-bad)' : 'var(--mut)'
      return svg(
        W,
        H,
        `
        <line class="gridline" x1="${P.l}" x2="${W - P.r}" y1="${y(1)}" y2="${y(1)}" stroke-dasharray="2 3"/>
        <path d="${line}" fill="none" stroke="${tone}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${x(last.t)}" cy="${y(last.v)}" r="3.5" fill="${tone}" stroke="var(--sur)" stroke-width="2"/>`,
      )
    }
    const deltaChip = (f) => {
      if (!f.collected) return ''
      if (f.delta === 0) return `<span class="delta flat">no change</span>`
      const up = f.delta > 0
      return `<span class="delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(f.delta)} pts</span>`
    }

    host.innerHTML = `
      <h3>State by rule</h3>
      <div class="legend-row dir-key">
        <span>Change over the window:</span>
        ${[
          ['var(--c-ok)', 'improving'],
          ['var(--c-bad)', 'regressing'],
          ['var(--mut)', 'unchanged'],
        ]
          .map(
            ([c, l]) =>
              `<span><svg class="swatch" viewBox="0 0 16 8" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4"
            stroke="${c}" stroke-width="2" stroke-linecap="round"/></svg>${l}</span>`,
          )
          .join('')}
        <span class="key-note">colour is direction here, not state</span>
      </div>
      <div class="facets">${facets
        .map(
          (f) => `<div class="facet${f.collected ? '' : ' muted'}">
        <h4>${f.name}</h4>
        <div class="now">${f.collected ? `${Math.round(f.rate * 100)}% · ${f.met}/${f.applicable} ${deltaChip(f)}` : 'not collected yet'}</div>
        ${
          f.collected
            ? spark(f)
            : `<span class="chip unk" style="margin-top:10px"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7.5" stroke-dasharray="3 2.6"/></svg>Not scanned</span>`
        }
      </div>`,
        )
        .join('')}</div>`
  }

  function renderAnalytics() {
    statsCache = new Map() // filters or a curated decision change every night at once
    renderRangeBar()
    chartTrend()
    chartChecks()
  }

  // ── tabs ────────────────────────────────────────────────────────────────────────────
  function setTab(name) {
    const analytics = name === 'analytics'
    state.tab = analytics ? 'analytics' : 'table'
    root.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)))
    $id('analytics').hidden = !analytics
    root.querySelector('.tablewrap').hidden = analytics
    root.querySelector('.bar').hidden = analytics
    root.querySelector('.summary').hidden = analytics
    root.querySelector('.foot').hidden = analytics
    hideTip()
    if (analytics) {
      closeDetails()
      renderAnalytics()
    }
  }
  // The sticky table header needs the bar's REAL height, which changes for more reasons than a resize.
  const topBar = new ResizeObserver(([e]) =>
    // getBoundingClientRect, not contentRect: the bar's padding and border also cover the table.
    hostEl.style.setProperty('--top-h', `${Math.round(e.target.getBoundingClientRect().height)}px`),
  )
  topBar.observe(root.querySelector('.top'))

  // Redraw on resize — letting the SVG stretch would scale the axis type with it.
  let resizeTimer = null
  on(window, 'resize', () => {
    if ($id('analytics').hidden) return
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(renderAnalytics, 120)
  })
  $id('tabs').onclick = (e) => {
    const b = e.target.closest('button')
    if (!b || b.dataset.tab === state.tab) return
    setTab(b.dataset.tab)
    // A tab is a move between two views, not a refinement of one: Back should return to the other.
    writeUrl({ push: true })
  }

  // A seam for QA, not an API; dropped from the production bundle.
  if (import.meta.env.DEV) {
    window.GP = {
      get DATA() {
        return DATA
      },
      get HISTORY() {
        return HISTORY
      },
      get decisionLog() {
        return decisionLog
      },
      state,
      SEGMENTS,
      cellsOf,
      segmentOf,
      totalOf,
      statsOn,
      render,
      openDetails,
      renderAnalytics,
      root,
    }
  }

  // First paint waits for the decision log too, or approved deviations would show as open.
  Promise.all([loadHistory(), loadDecisionLog(), loadRules()])
    .then(() => {
      renderProvenance()
      // readUrl needs the loaded history for the analytics window, so it cannot run earlier.
      readUrl()
      syncControls()
      render()
      if (state.tab === 'analytics') setTab('analytics')
      const deep = new URLSearchParams(location.search).get('component')
      if (deep && DATA.some((u) => u.repository === deep)) openDetails(deep)
    })
    .catch((err) => {
      $id('tbl').innerHTML = `<tbody><tr><td style="padding:40px;text-align:center;color:var(--faint)">${esc(err.message)}</td></tr></tbody>`
    })

  return () => {
    off.forEach((f) => f())
    topBar.disconnect()
    clearTimeout(toast._t)
    clearTimeout(resizeTimer)
    if (import.meta.env.DEV) delete window.GP
  }
}
