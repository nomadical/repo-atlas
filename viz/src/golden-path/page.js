/* Golden Path compliance screen: interface and state only; all evaluation lives in golden-path/lib/*.mjs.
   Runs in a shadow root whose generic class names would collide with the app's CSS, so query via
   `root`, never `document`. */
import {
  loadHistory as fetchHistory,
  loadExceptions as fetchExceptions,
  loadRules as fetchRules,
  appendException,
} from './data.js'
import { replay, auditLine, asOfDate } from '@golden-path/lib/decision-log.mjs'
import {
  RULES,
  CHECKS,
  COLLECTED,
  SOURCE,
  setRules,
  deriveCollected,
  cellsOf as evaluateCells,
  totalOf,
} from '@golden-path/lib/rules.mjs'
import { SEGMENTS, segmentOf as segmentWithLog, segmentCounts } from '@golden-path/lib/segments.mjs'
import { expandHistory, statsOn as statsForNight } from '@golden-path/lib/history.mjs'
import { toParams, fromParams, defaultState, PARAM_KEYS } from '@golden-path/lib/url.mjs'

// ── Icons ───────────────────────────────────────────────────────────────────────────────

const STATE_ICONS = {
  ok: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  bad: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  dev: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5 19 6v5.5c0 4-2.9 7.4-7 8.9-4.1-1.5-7-4.9-7-8.9V6l7-2.5Z"/></svg>',
  unk: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7.5" stroke-dasharray="3 2.6"/></svg>',
  na: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M7 12h10"/></svg>',
}
const TICK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>'
const GITHUB_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48l-.01-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.36 1.09 2.93.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85l-.01 2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2.2Z"/></svg>'
const MAP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><circle cx="6" cy="6.5" r="2.6"/><circle cx="18" cy="6.5" r="2.6"/><circle cx="12" cy="17.5" r="2.6"/><path d="M7.9 8.3 10.7 15M16.1 8.3 13.3 15M8.6 6.5h6.8" stroke-linecap="round"/></svg>'

const SHELL = `
<div class="top">
  <span class="mark"></span>
  <div><h1>Golden Path compliance</h1><div class="sub">Derived 2026-08-11 03:34 UTC</div></div>
  <nav class="tabs" id="tabs" role="tablist">
    <button role="tab" type="button" id="tab-table" data-tab="table" aria-selected="true" aria-controls="view-table">Compliance</button>
    <button role="tab" type="button" id="tab-analytics" data-tab="analytics" aria-selected="false" aria-controls="analytics" tabindex="-1">Analytics</button>
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
  <div class="view" id="view-table" role="tabpanel" aria-labelledby="tab-table">
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
      <button class="ms-btn" type="button" aria-expanded="false" aria-controls="settings-panel" aria-label="View settings">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.04Z"/></svg>
        Settings<span class="car"></span></button>
      <div class="ms-panel" id="settings-panel" style="min-width:290px">
        <label class="set"><input type="checkbox" id="grp"><span>Group by owner</span></label>
        <p class="set-title" id="seg-title">Repositories shown</p>
        <div id="segments"></div>
      </div>
    </div>
    <input class="search" id="q" type="search" placeholder="Search components" aria-label="Search components">
  </div>
  <div class="panel tablewrap"><table id="tbl"></table></div>
  <div class="foot">
    <span id="hidden-note" style="color:var(--mut)"></span>
    <span class="chip ok">${STATE_ICONS.ok}Conforms</span>
    <span class="chip bad">${STATE_ICONS.bad}Deviation</span>
    <span class="chip dev">${STATE_ICONS.dev}Approved deviation</span>
    <span class="chip unk">${STATE_ICONS.unk}Not scanned — counts against the total</span>
    <span class="chip na">${STATE_ICONS.na}Not applicable — excluded from the total</span>
  </div>
  </div>
  <section id="analytics" role="tabpanel" aria-labelledby="tab-analytics" hidden>
    <div class="rangetop panel" id="rangetop"></div>
    <div class="charts">
      <figure class="panel chart" id="ch-trend"></figure>
      <figure class="panel chart" id="ch-checks"></figure>
    </div>
  </section>
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

// ── Text and markup helpers ─────────────────────────────────────────────────────────────

// Everything renders via innerHTML, and curator-typed decision fields (ref, reason, author) reach every reader.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (text) => String(text).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char])

// Table cells drop the trailing parenthetical qualifier; the panel carries the detail.
const withoutQualifier = (text) => String(text).replace(/\s*\([^)]*\)\s*$/, '')

const countState = (cells, state) => cells.filter((cell) => cell.s === state).length

function cellText(cell) {
  if (cell.s === 'dev') return cell.audit?.ref ? `${cell.v} · ${cell.audit.ref}` : `${cell.v} · approved`
  if (cell.s === 'ok' || cell.s === 'bad') return cell.v
  if (cell.s === 'na') return 'n/a'
  return 'Not scanned'
}

function cellTooltip(cell) {
  const expected = cell.reason || (cell.spec ? 'Expected ' + cell.spec : '')
  const found = cell.v ? ' — found ' + cell.v : ''
  return expected + found
}

const STATE_WORDS = { dev: 'Approved', ok: 'Conforms', bad: 'Deviation', na: 'n/a' }
const stateWord = (cell) => STATE_WORDS[cell.s] || 'Not scanned'

// The drawer's one-line reading of a check: what was found against what is expected.
function checkSummary(cell) {
  if (cell.excluded) return 'Not assessed'
  if (!cell.spec) return cell.reason
  if (cell.s === 'ok') return cell.v
  return cell.v ? `${cell.v} · expected ${cell.spec}` : `Expected ${cell.spec}`
}

// Conforming, approved and open segments of a bar whose full width is `total`.
const BAR_SEGMENTS = [
  ['ok', 'var(--ok)'],
  ['dev', 'var(--dev)'],
  ['bad', 'var(--bad)'],
]
function stackedBar(cells, total) {
  return BAR_SEGMENTS.map(([state, color]) => {
    const count = countState(cells, state)
    return count ? `<i style="width:${(count / total) * 100}%;background:${color}"></i>` : ''
  }).join('')
}

function joinWithAnd(items) {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function sourceNote(source) {
  if (!source?.name) return null
  const revision = source.version
    ? ` v${esc(source.version)}`
    : source.lastModified
      ? ` · ${esc(source.lastModified)}`
      : ''
  const name = source.url
    ? `<a href="${esc(source.url)}" target="_blank" rel="noopener">${esc(source.name)}</a>`
    : esc(source.name)
  return name + revision
}

// ── Summary strip ───────────────────────────────────────────────────────────────────────

// Visual scale of the summary bars: how wide one item draws, in percent.
const OPEN_DEVIATION_WIDTH = 6
const APPROVED_DEVIATION_WIDTH = 25
const UNSCANNED_CHECK_WIDTH = 1.4

// A check column whose conforming share is below this reads as a warning.
const LOW_CONFORMANCE = 0.6

// ── Decisions ───────────────────────────────────────────────────────────────────────────

const MOVE_APPROVE = {
  v: 'deviation',
  label: 'Approve deviation',
  hint: 'Divergence is accepted; counts as met.',
}
const MOVE_NOT_APPLICABLE = {
  v: 'not-applicable',
  label: 'Not applicable',
  hint: 'The rule does not apply here; leaves the total.',
}
const MOVE_REMOVE_APPROVAL = { v: 'revoke', label: 'Remove approval', hint: 'Back to an open deviation.' }
const MOVE_REMOVE_EXEMPTION = { v: 'revoke', label: 'Remove exemption', hint: 'Back into the total.' }

const MOVE_DONE_MESSAGE = {
  deviation: 'Deviation approved',
  'not-applicable': 'Marked not applicable',
  revoke: 'Decision removed',
}

// The whole-component forms: `exclude` excludes it, `revoke` ends the exclusion.
const FORMS = {
  exclude: {
    title: 'Exclude whole component',
    why: 'Why the Golden Path does not apply to this component at all',
    entryType: 'exclusion',
    doneMessage: 'Component excluded',
  },
  revoke: {
    title: 'Remove exclusion',
    why: 'Why this component comes back into scope',
    entryType: 'revoke',
    doneMessage: 'Exclusion removed',
  },
}

const THEME_KEY = 'gp-theme'
const TOAST_MS = 2600
const RESIZE_DEBOUNCE_MS = 120

// ── Charts ──────────────────────────────────────────────────────────────────────────────

const DAY_MS = 864e5
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const STATE_COLOR = { ok: 'var(--c-ok)', dev: 'var(--c-dev)', bad: 'var(--c-bad)', unk: 'var(--unk)' }
const STATE_LABEL = {
  ok: 'Conforming',
  dev: 'Approved deviation',
  bad: 'Open deviation',
  unk: 'Not scanned',
}
const TREND_SERIES = ['ok', 'dev', 'bad', 'unk']

// Clamped to the first night on record: an empty left half would read as "nothing happened".
const RANGES = {
  quarter: { label: 'Quarter', days: 90 },
  year: { label: 'Year', days: 365 },
  all: { label: 'All time', days: null },
}

const TREND_MIN_WIDTH = 700
const TREND_HEIGHT = 300
const TREND_PADDING = { l: 34, r: 46, t: 12, b: 26 }
const TREND_Y_STEP = 25
// End-of-line value labels are pushed apart until they are at least this far apart.
const END_LABEL_GAP = 13

const SPARK_WIDTH = 200
const SPARK_HEIGHT = 58
const SPARK_PADDING = { l: 2, r: 2, t: 7, b: 4 }
// Headroom above 100% so the top line is not clipped.
const SPARK_HEADROOM = 1.08

const isoDay = (t) => new Date(t).toISOString().slice(0, 10)
const dayAndMonth = (date) => `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`

// Bucket size keeps the plotted point count roughly constant across window sizes.
function bucketDays(spanDays) {
  if (spanDays < 100) return 1
  if (spanDays <= 400) return 7
  return 30
}

function grainDescription(grain) {
  if (grain === 1) return 'one point per night'
  if (grain === 7) return 'weekly means of nightly samples'
  return 'monthly means of nightly samples'
}

const middleOf = (chunk) => chunk[Math.floor(chunk.length / 2)]

function resample(daily, days) {
  if (days === 1) return daily.map((day) => ({ ...day, from: day.t, to: day.t }))
  const out = []
  for (let start = 0; start < daily.length; start += days) {
    const chunk = daily.slice(start, start + days)
    const mean = (key) => Math.round(chunk.reduce((sum, day) => sum + day[key], 0) / chunk.length)
    out.push({
      t: middleOf(chunk).t,
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
  Object.assign(out[out.length - 1], {
    t: lastDay.t,
    to: lastDay.t,
    ok: lastDay.ok,
    dev: lastDay.dev,
    bad: lastDay.bad,
    unk: lastDay.unk,
  })
  return out
}

// Same bucketing for a series of rates ({ t, v }); the last point is again the latest night.
function resampleRates(daily, days) {
  if (days === 1) return daily
  const out = []
  for (let start = 0; start < daily.length; start += days) {
    const chunk = daily.slice(start, start + days)
    out.push({
      t: middleOf(chunk).t,
      v: chunk.reduce((sum, point) => sum + point.v, 0) / chunk.length,
    })
  }
  out[out.length - 1] = daily[daily.length - 1]
  return out
}

function dailyTicks(from, to) {
  const ticks = []
  for (let t = from; t <= to; t += DAY_MS) ticks.push({ t, label: dayAndMonth(new Date(t)) })
  return ticks
}

function weeklyTicks(from, to) {
  const ticks = []
  const firstMonday = new Date(from)
  firstMonday.setUTCDate(firstMonday.getUTCDate() + ((8 - firstMonday.getUTCDay()) % 7))
  for (let t = firstMonday.getTime(); t <= to; t += 7 * DAY_MS) {
    ticks.push({ t, label: dayAndMonth(new Date(t)) })
  }
  return ticks
}

function monthlyTicks(from, to) {
  const ticks = []
  const start = new Date(from)
  const month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
  while (month.getTime() <= to) {
    const isJanuary = month.getUTCMonth() === 0
    const yearSuffix = isJanuary ? ' ’' + String(month.getUTCFullYear()).slice(2) : ''
    ticks.push({ t: month.getTime(), label: MONTHS[month.getUTCMonth()] + yearSuffix })
    month.setUTCMonth(month.getUTCMonth() + 1)
  }
  return ticks
}

// Label the opening year at the left edge when the window starts far from 1 January.
const OPENING_YEAR_MIN_GAP = 45 * DAY_MS

function yearlyTicks(from, to) {
  const ticks = []
  const openingYear = new Date(from).getUTCFullYear()
  const firstJanuary = Date.UTC(openingYear + 1, 0, 1)
  if (firstJanuary - from > OPENING_YEAR_MIN_GAP) ticks.push({ t: from, label: String(openingYear) })
  const year = new Date(firstJanuary)
  while (year.getTime() <= to) {
    ticks.push({ t: year.getTime(), label: String(year.getUTCFullYear()) })
    year.setUTCFullYear(year.getUTCFullYear() + 1)
  }
  return ticks
}

// Ticks follow the span, not the range name.
function ticksFor(from, to) {
  const spanDays = (to - from) / DAY_MS
  if (spanDays < 14) return dailyTicks(from, to)
  if (spanDays <= 100) return weeklyTicks(from, to)
  if (spanDays <= 400) return monthlyTicks(from, to)
  return yearlyTicks(from, to)
}

const svgFrame = (width, height, body, label) =>
  `<svg viewBox="0 0 ${width} ${height}" role="img" style="max-width:${width}px"${label ? ` aria-label="${label}"` : ''}>${body}</svg>`

const legend = (states) =>
  `<div class="legend-row">${states
    .map(
      (state) =>
        `<span><svg class="swatch" viewBox="0 0 16 8" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4"
       stroke="${STATE_COLOR[state]}" stroke-width="2" stroke-linecap="round"${state === 'unk' ? ' stroke-dasharray="4 3"' : ''}/></svg>${STATE_LABEL[state]}</span>`,
    )
    .join('')}</div>`

const pathThrough = (points) =>
  points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')

// Stroke colour is DIRECTION over the window, not level: green/red already mean conform/deviate here.
function directionColor(delta) {
  if (delta > 0) return 'var(--c-ok)'
  if (delta < 0) return 'var(--c-bad)'
  return 'var(--mut)'
}

const DIRECTION_KEY = [
  ['var(--c-ok)', 'improving'],
  ['var(--c-bad)', 'regressing'],
  ['var(--mut)', 'unchanged'],
]

function deltaChip(facet) {
  if (!facet.collected) return ''
  if (facet.delta === 0) return `<span class="delta flat">no change</span>`
  const up = facet.delta > 0
  return `<span class="delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(facet.delta)} pts</span>`
}

// ── The screen ──────────────────────────────────────────────────────────────────────────

// hostEl carries the theme attribute (and so the tokens); returns the teardown for React's effect.
export function mountPage(hostEl, root) {
  // Append, don't assign: the caller's <style> is already in the root and must stay.
  const shell = document.createElement('template')
  shell.innerHTML = SHELL
  root.append(shell.content)

  const byId = (id) => root.getElementById(id)
  const removers = []
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler)
    removers.push(() => target.removeEventListener(type, handler))
  }
  // A shadow root retargets events: the element actually clicked comes from composedPath, not e.target.
  const clickedElement = (event) => event.composedPath()[0] ?? event.target

  // The unit is the REPOSITORY, not the inventory component (1:1 today); `arch-map-ignore` repos are dropped.
  let repositories = []
  let nights = [] // [{ d: 'YYYY-MM-DD', t: ms, rows: { repo: row } }], oldest first
  let latestNight = null
  let today = 0 // the newest night on record, not the wall clock
  let allTimeFrom = 0

  // From history.json. Before the first stamped night there is no org, so repository links are omitted.
  let org = ''
  const repositoryUrl = (repo) => (org ? `https://github.com/${org}/${repo}` : null)
  // The map is this same app without ?view=golden-path; it deep-links a node with ?sel=<serviceId|folder>.
  const MAP_URL = location.pathname
  byId('map-link').href = MAP_URL

  // `decisionLogRead`: the decisions on screen are real. `canCurate` gates every editing control. Both server-set.
  let decisionEntries = []
  let decisionLog = replay([])
  let decisionLogRead = false
  let canCurate = false

  const state = defaultState()
  const range = { key: 'all', from: 0, to: 0 } // filled from the history once it loads
  let customRangeOpen = false // the fields are a disclosure: closing them keeps the window, hides the form

  let lastRow = null
  let current = null
  let foldOpen = false
  let editing = null
  let segCounts = {}
  let statsCache = new Map()
  let toastTimer = null
  let resizeTimer = null

  const cellsOf = (repo, asOf) => evaluateCells(repo, decisionLog, asOf)
  const segmentOf = (repo, asOf) => segmentWithLog(repo, decisionLog, asOf)
  // asOfDate hides exclusions that have since been revoked.
  const exclusionOf = (repoName) => asOfDate(decisionLog.excluded[repoName])
  const drawerIsOpen = () => byId('drawer').classList.contains('open')

  // ── Loading ───────────────────────────────────────────────────────────────────────────

  async function loadHistory() {
    const file = await fetchHistory()
    if (file.org) org = file.org
    nights = expandHistory(file)
    latestNight = nights[nights.length - 1]
    repositories = Object.values(latestNight.rows)
    deriveCollected(repositories) // a check counts as collected once a night carries it
    today = latestNight.t
    allTimeFrom = nights[0].t
    range.from = allTimeFrom
    range.to = today
  }

  // A missing rules file is not fatal: the library keeps its fallback.
  async function loadRules() {
    const file = await fetchRules()
    if (file) setRules(file)
  }

  function applyDecisionLog(entries) {
    decisionEntries = entries
    decisionLog = replay(entries)
  }

  // UI gating only; the refusal lives server-side. An unreachable decision log reads as "not a curator".
  async function loadDecisionLog() {
    const result = await fetchExceptions()
    applyDecisionLog(result?.entries || [])
    decisionLogRead = result !== null
    canCurate = result?.mayCurate === true
  }

  async function recordDecision(entry) {
    applyDecisionLog([...decisionEntries, await appendException(entry)])
  }

  function renderProvenance() {
    const parts = [`${nights.length} nightly runs`, `latest ${latestNight.d}`]
    const source = sourceNote(SOURCE)
    if (source) parts.push(source)
    // Without the decision log an approved deviation reads as an open one, so say so.
    if (!decisionLogRead) {
      parts.push(
        '<span class="warn-note" title="Approved deviations cannot be shown, so they are counted as open ones.">decisions unavailable</span>',
      )
    }
    root.querySelector('.top .sub').innerHTML = parts.join(' · ')
  }

  // ── URL ───────────────────────────────────────────────────────────────────────────────

  function rangeStart(key) {
    const { days } = RANGES[key]
    return days ? Math.max(allTimeFrom, today - days * DAY_MS) : allTimeFrom
  }

  function urlFor(repo) {
    const params = new URLSearchParams(location.search)
    const wanted = toParams({ state, range, component: repo })
    for (const key of PARAM_KEYS) {
      if (wanted[key]) params.set(key, wanted[key])
      else params.delete(key)
    }
    const query = params.toString()
    return query ? `?${query}` : location.pathname
  }

  // push for a move Back should undo (tab, component); replace for a refinement like typing a search.
  function writeUrl({ push = false, repo = null } = {}) {
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
      range.from = parsed.range.from || allTimeFrom
      range.to = parsed.range.to || today
      customRangeOpen = true
    } else {
      // A named window is recomputed from the history, not read from the link.
      range.from = rangeStart(range.key)
      range.to = today
      customRangeOpen = false
    }
  }

  // render() rebuilds the multi-selects, but these three are plain inputs that must be synced by hand.
  function syncControls() {
    byId('q').value = state.q
    byId('grp').checked = state.group
    for (const button of root.querySelectorAll('#seg button')) {
      button.setAttribute('aria-pressed', String(button.dataset.f === state.filter))
    }
  }

  // ── Filters ───────────────────────────────────────────────────────────────────────────

  // Ownerless rows need a selectable label: undefined would stringify to an option that never matches.
  const ownerLabel = (repo) => repo.owner || 'No owner'

  // Same predicate for every night, so the charts show the history of exactly what the table shows.
  function matchesFilters(repo, asOf) {
    if (!state.segments.has(segmentOf(repo, asOf))) return false
    if (state.type.size && !state.type.has(repo.type)) return false
    if (state.owner.size && !state.owner.has(ownerLabel(repo))) return false
    if (state.q) {
      const haystack = `${repo.repository} ${repo.inventoryName || ''}`.toLowerCase()
      if (!haystack.includes(state.q.toLowerCase())) return false
    }
    const cells = cellsOf(repo, asOf)
    if (state.filter === 'dev' && !cells.some((cell) => cell.s === 'bad')) return false
    if (state.filter === 'unk' && !cells.some((cell) => cell.s === 'unk')) return false
    return true
  }

  function setDropdownOpen(node, open) {
    node.classList.toggle('open', open)
    node.querySelector('.ms-btn').setAttribute('aria-expanded', String(open))
  }

  function closeAllDropdowns() {
    for (const dropdown of root.querySelectorAll('.ms.open')) setDropdownOpen(dropdown, false)
  }

  function toggleDropdown(node) {
    const open = !node.classList.contains('open')
    closeAllDropdowns()
    setDropdownOpen(node, open)
  }

  // Escape closes an open dropdown before it closes the drawer, and hands focus back to the trigger.
  function closeDropdownOnEscape(event) {
    const open = root.querySelector('.ms.open')
    if (event.key !== 'Escape' || !open) return false
    setDropdownOpen(open, false)
    open.querySelector('.ms-btn').focus()
    return true
  }

  // Real checkboxes, so Tab and Space work; the input is hidden and .ms-box draws the tick.
  function multiSelectHtml(node, name, values, selected, counts) {
    const options = values
      .map(
        (
          value,
        ) => `<label class="ms-opt"><input type="checkbox" value="${esc(value)}"${selected.has(value) ? ' checked' : ''}>
            <span class="ms-box">${TICK_ICON}</span>${esc(value)}<span class="cnt">${counts.get(value) || 0}</span></label>`,
      )
      .join('')
    return `
      <button class="ms-btn" type="button" aria-expanded="false" aria-controls="${node.id}-panel"
        aria-label="${name}${selected.size ? `, ${selected.size} selected` : ''}">
        <span aria-hidden="true">${name}</span><span class="ms-count"${selected.size ? '' : ' hidden'} aria-hidden="true">${selected.size}</span><span class="car"></span></button>
      <div class="ms-panel" id="${node.id}-panel" role="group" aria-label="${name}">
        ${options}
        <button class="ms-clear" type="button">Clear selection</button></div>`
  }

  function renderMultiSelect(node, name, values, selected, counts) {
    node.innerHTML = multiSelectHtml(node, name, values, selected, counts)
    // The rebuild replaces the focused control, so focus its replacement for keyboard readers.
    const refresh = (focusTarget) => {
      render(node.id)
      writeUrl()
      focusTarget(byId(node.id))?.focus()
    }
    node.querySelector('.ms-btn').onclick = () => toggleDropdown(node)
    for (const checkbox of node.querySelectorAll('.ms-opt input')) {
      checkbox.onchange = () => {
        if (checkbox.checked) selected.add(checkbox.value)
        else selected.delete(checkbox.value)
        refresh((fresh) =>
          [...fresh.querySelectorAll('.ms-opt input')].find((input) => input.value === checkbox.value),
        )
      }
    }
    node.querySelector('.ms-clear').onclick = () => {
      selected.clear()
      refresh((fresh) => fresh.querySelector('.ms-clear'))
    }
  }

  // Type and Owner count inside the chosen segments; segment counts stay absolute.
  function renderFilterMenus() {
    const inSegments = repositories.filter((repo) => state.segments.has(segmentOf(repo)))
    const menu = (nodeId, name, valueOf, selected) => {
      const values = [...new Set(inSegments.map(valueOf))].sort()
      const counts = new Map()
      for (const repo of inSegments) {
        const value = valueOf(repo)
        counts.set(value, (counts.get(value) || 0) + 1)
      }
      renderMultiSelect(byId(nodeId), name, values, selected, counts)
    }
    menu('ms-type', 'Type', (repo) => repo.type, state.type)
    menu('ms-owner', 'Owner', ownerLabel, state.owner)
  }

  function reopenDropdown(nodeId) {
    const node = byId(nodeId)
    if (node) setDropdownOpen(node, true)
  }

  // Rebuilt every render: a curated exclusion moves a repository from one group to another.
  function renderSegments() {
    segCounts = segmentCounts(repositories, decisionLog)
    const allChosen = state.segments.size === SEGMENTS.length
    const someChosen = state.segments.size > 0 && !allChosen
    const option = (id, extraClass, checked, label, hint, count) => `
      <label class="set${extraClass}"><input type="checkbox" data-seg="${id}"${checked ? ' checked' : ''}>
        <span>${label}${hint ? `<small>${hint}</small>` : ''}</span><span class="n">${count}</span></label>`
    const segmentOptions = SEGMENTS.map((segment) =>
      option(
        segment.k,
        '',
        state.segments.has(segment.k),
        segment.label,
        segment.hint,
        segCounts[segment.k] || 0,
      ),
    )
    byId('segments').innerHTML =
      option('*', ' all', allChosen, 'All repositories', '', repositories.length) + segmentOptions.join('')
    root.querySelector('#segments input[data-seg="*"]').indeterminate = someChosen
  }

  function onSegmentChange(event) {
    const key = event.target.dataset.seg
    const checked = event.target.checked
    if (key === '*') {
      if (checked) SEGMENTS.forEach((segment) => state.segments.add(segment.k))
      else state.segments.clear()
    } else if (checked) {
      state.segments.add(key)
    } else {
      state.segments.delete(key)
    }
    state.type.clear()
    state.owner.clear()
    render('settings')
    writeUrl()
    // The list was rebuilt, so re-focus the (new) checkbox element for keyboard readers.
    root.querySelector(`#segments input[data-seg="${key}"]`)?.focus()
  }

  function renderHiddenNote() {
    const chosen = SEGMENTS.filter((segment) => state.segments.has(segment.k))
    const notShown = SEGMENTS.reduce(
      (sum, segment) => sum + (state.segments.has(segment.k) ? 0 : segCounts[segment.k] || 0),
      0,
    )
    let shownText
    if (!chosen.length) shownText = 'No group selected'
    else if (chosen.length === SEGMENTS.length) shownText = 'Every repository in the organisation'
    else shownText = `Showing ${joinWithAnd(chosen.map((segment) => segment.label.toLowerCase()))}`
    byId('hidden-note').textContent = shownText + (notShown ? ` · ${notShown} not shown` : '')
  }

  // ── Table ─────────────────────────────────────────────────────────────────────────────

  function metRatio(repo) {
    const total = totalOf(cellsOf(repo))
    return total.of ? total.met / total.of : 1
  }

  // Worst first; ties by name.
  function sortedVisibleRows() {
    return repositories
      .filter((repo) => matchesFilters(repo))
      .sort((a, b) => metRatio(a) - metRatio(b) || a.repository.localeCompare(b.repository))
  }

  function rowBadges(repo) {
    const exclusion = exclusionOf(repo.repository)
    const archived = repo.archived ? '<span class="arch">archived</span>' : ''
    const excluded = exclusion
      ? `<span class="arch excl" title="${esc(auditLine(exclusion)) || 'Excluded from the Golden Path'}">excluded</span>`
      : ''
    const owner = repo.owner
      ? `<span class="owner">${esc(repo.owner)}</span>`
      : '<span class="owner">no owner</span>'
    return `<span class="kind">${repo.type}</span>${archived}${excluded}${owner}`
  }

  const checkCellHtml = (cell) =>
    `<td><span class="chip ${cell.s}" title="${esc(cellTooltip(cell))}">${STATE_ICONS[cell.s]}<span class="t">${esc(withoutQualifier(cellText(cell)))}</span></span></td>`

  function rowTotalHtml(cells) {
    const total = totalOf(cells)
    if (!total.of) return '<span class="v" style="color:var(--na)">not assessed</span>'
    return `<span class="v ${total.met === total.of ? 'perfect' : 'bad'}"><b>${total.met}</b>/${total.of}</span>
           <span class="rowbar">${stackedBar(cells, total.of)}</span>`
  }

  function rowHtml(repo) {
    const cells = cellsOf(repo)
    const name = esc(repo.repository)
    const title = name + (repo.inventoryName ? ` — inventory: ${esc(repo.inventoryName)}` : '')
    // The row stays a table row; its name is the button, and a click anywhere on the row does the same.
    return `<tr data-repo="${name}">
      <td><button class="nm" type="button" aria-expanded="false" aria-controls="drawer" title="${title}">${name}</button><div class="sub2">${rowBadges(repo)}
        </div></td>
      ${cells.map(checkCellHtml).join('')}
      <td><div class="total">${rowTotalHtml(cells)}</div></td></tr>`
  }

  function renderSummary(rows, cellsByRow) {
    const countAll = (cellState) => cellsByRow.reduce((sum, cells) => sum + countState(cells, cellState), 0)
    const openDeviations = countAll('bad')
    const approved = countAll('dev')
    const unscanned = countAll('unk')
    byId('summary').innerHTML = `
      <div class="st"><div class="n">${rows.length}</div><div class="l">Components shown</div>
        <div class="track"><i style="width:${(rows.length / repositories.length) * 100}%;background:var(--acc)"></i></div></div>
      <div class="st"><div class="n bad">${openDeviations}</div><div class="l">Open deviations</div>
        <div class="track"><i style="width:${Math.min(100, openDeviations * OPEN_DEVIATION_WIDTH)}%;background:var(--bad)"></i></div></div>
      <div class="st"><div class="n dev">${approved}</div><div class="l">Approved deviations</div>
        <div class="track"><i style="width:${Math.min(100, approved * APPROVED_DEVIATION_WIDTH)}%;background:var(--dev)"></i></div></div>
      <div class="st"><div class="n">${unscanned}</div><div class="l">Checks not scanned</div>
        <div class="track"><i style="width:${Math.min(100, unscanned * UNSCANNED_CHECK_WIDTH)}%;background:var(--unk)"></i></div></div>`
  }

  function checkRateHtml(check, applicable) {
    const count = applicable.length
    if (!count) return `<span class="ck-rate off">not applicable</span><span class="ck-gap"></span>`
    if (!COLLECTED[check.k]) {
      return `<span class="ck-rate off">not collected</span><span class="ck-gap">${count} applicable</span>`
    }
    const good = countState(applicable, 'ok') + countState(applicable, 'dev')
    const unscanned = countState(applicable, 'unk')
    return `<span class="ck-rate${good / count < LOW_CONFORMANCE ? ' warn' : ''}"><b>${good}/${count}</b> conform</span>
           <span class="ck-gap">${unscanned ? unscanned + ' not scanned' : ''}</span>`
  }

  // Header meter and figure share one denominator (applicable cells) so they can never disagree.
  function checkHeaderHtml(check, index, rows, cellsByRow) {
    const applicable = cellsByRow.map((cells) => cells[index]).filter((cell) => cell.s !== 'na')
    const specs = [...new Set(rows.map((repo) => (RULES[repo.type] || {})[check.k]).filter(Boolean))]
    return `<th><span class="ck-name">${check.name}</span><span class="ck-spec">${specs.join(' · ') || '—'}</span>
        <span class="meter">${stackedBar(applicable, applicable.length)}</span>${checkRateHtml(check, applicable)}</th>`
  }

  function emptyTableHtml() {
    const message = state.segments.size
      ? 'No components match these filters. Clear a filter or switch back to All.'
      : 'No group of repositories is selected. Pick one under Repositories shown in Settings.'
    return `<tr><td colspan="${CHECKS.length + 2}" style="padding:40px;text-align:center;color:var(--faint)">${message}</td></tr>`
  }

  function ownerGroupHtml(owner, items) {
    let deviations = 0
    let met = 0
    let of = 0
    for (const repo of items) {
      const cells = cellsOf(repo)
      const total = totalOf(cells)
      deviations += countState(cells, 'bad')
      met += total.met
      of += total.of
    }
    const components = `${items.length} component${items.length > 1 ? 's' : ''}`
    const deviationText = `${deviations} deviation${deviations === 1 ? '' : 's'}`
    const header = `<tr class="grp"><td colspan="${CHECKS.length + 2}"><span class="g">${esc(owner)}</span>
          <span class="gm">${components} · ${met}/${of} checks met · ${deviationText}</span></td></tr>`
    return header + items.map(rowHtml).join('')
  }

  function groupedRowsHtml(rows) {
    const groups = new Map()
    for (const repo of rows) {
      const owner = ownerLabel(repo)
      if (!groups.has(owner)) groups.set(owner, [])
      groups.get(owner).push(repo)
    }
    return [...groups.keys()]
      .sort()
      .map((owner) => ownerGroupHtml(owner, groups.get(owner)))
      .join('')
  }

  function tableBodyHtml(rows) {
    if (!rows.length) return emptyTableHtml()
    if (state.group) return groupedRowsHtml(rows)
    return rows.map(rowHtml).join('')
  }

  function render(keepOpen) {
    const rows = sortedVisibleRows()
    const cellsByRow = rows.map((repo) => cellsOf(repo))
    renderSummary(rows, cellsByRow)

    const headers = CHECKS.map((check, index) => checkHeaderHtml(check, index, rows, cellsByRow)).join('')
    byId('tbl').innerHTML =
      `<colgroup><col class="c-name">${CHECKS.map(() => '<col class="c-check">').join('')}<col class="c-total"></colgroup>
       <thead><tr><th><span class="ck-name">Component</span><span class="ck-spec">${rows.length} shown of ${repositories.length}</span></th>
        ${headers}<th><span class="ck-name">Checks met</span><span class="ck-spec">of applicable</span></th></tr></thead>
       <tbody>${tableBodyHtml(rows)}</tbody>`

    renderSegments()
    renderFilterMenus()
    if (keepOpen) reopenDropdown(keepOpen)
    renderHiddenNote()
  }

  // ── Theme ─────────────────────────────────────────────────────────────────────────────

  function setTheme(theme) {
    if (theme === 'system') {
      hostEl.removeAttribute('data-theme')
      localStorage.removeItem(THEME_KEY)
    } else {
      hostEl.setAttribute('data-theme', theme)
      localStorage.setItem(THEME_KEY, theme)
    }
    for (const button of root.querySelectorAll('#theme button')) {
      button.setAttribute('aria-pressed', String(button.dataset.t === theme))
    }
  }

  // ── Details drawer ────────────────────────────────────────────────────────────────────

  // Screen-reader announcement for panel changes that do not move focus (j/k traversal).
  function announce(message) {
    let region = byId('live')
    if (!region) {
      region = document.createElement('div')
      region.id = 'live'
      region.setAttribute('aria-live', 'polite')
      region.style.cssText =
        'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap'
      root.appendChild(region)
    }
    region.textContent = message
  }

  function toast(message) {
    const node = byId('toast')
    node.textContent = message
    node.classList.add('on')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => node.classList.remove('on'), TOAST_MS)
  }

  // Which decisions a cell can move to; non-curators get none but still see what was decided.
  function movesFor(cell) {
    if (!canCurate) return []
    if (cell.s === 'bad') return [MOVE_APPROVE, MOVE_NOT_APPLICABLE]
    if (cell.s === 'unk') return [MOVE_NOT_APPLICABLE]
    if (cell.s === 'dev') return [MOVE_REMOVE_APPROVAL]
    if (cell.s === 'na' && cell.curated) return [MOVE_REMOVE_EXEMPTION]
    return []
  }

  function rowEditorHtml(cell, index) {
    const moves = movesFor(cell)
      .map(
        (move, position) => `<label class="move">
          <input type="radio" name="f-move" value="${move.v}" ${position === 0 ? 'checked' : ''}>
          <span><b>${move.label}</b><small>${move.hint}</small></span></label>`,
      )
      .join('')
    return `<div class="rowedit" id="rowedit">
      <div class="moves">
        ${moves}
      </div>
      <label for="f-ref">Decision reference <span class="opt">optional</span></label>
      <input id="f-ref" placeholder="Ticket, document or meeting note" autocomplete="off">
      <label for="f-why">Reason <span class="opt">optional</span></label>
      <textarea id="f-why" placeholder="Why this decision was taken"></textarea>
      <div class="err" id="f-err" role="alert" hidden></div>
      <div class="btnrow">
        <button class="btn primary" type="button" id="f-save" data-i="${index}">Save</button>
        <button class="btn" type="button" id="f-cancel">Cancel</button>
      </div>
    </div>`
  }

  function checkRowHtml(cell, index) {
    const trail = auditLine(cell.audit)
    const trailHtml = trail ? `<small class="trail">${esc(trail)}</small>` : ''
    const open = editing === index
    const changeButton = movesFor(cell).length
      ? `<button class="change" type="button" data-edit="${index}" aria-expanded="${open}">${open ? 'Close' : 'Change'}</button>`
      : ''
    return `<div class="d-row ${open ? 'editing' : ''}">
        <span class="d-lbl">${CHECKS[index].name}<small>${esc(checkSummary(cell))}</small>${trailHtml}</span>
        <span class="d-state">
          <span class="chip ${cell.s}">${STATE_ICONS[cell.s]}${stateWord(cell)}</span>
          ${changeButton}
        </span>
      </div>${open ? rowEditorHtml(cell, index) : ''}`
  }

  function exclusionNoteHtml(exclusion) {
    const trail = auditLine(exclusion)
    const trailHtml = trail ? `<br><span style="color:var(--faint)">${esc(trail)}</span>` : ''
    return `<p class="d-note" style="margin-top:16px">Excluded from the Golden Path — nothing here counts towards any figure on this page.${trailHtml}</p>`
  }

  function foldedChecksHtml(repo, folded) {
    if (!folded.length) return ''
    return `
        <button class="d-fold" id="d-fold" aria-expanded="${foldOpen}" aria-controls="d-na">
          <span class="car"></span>${folded.length} not applicable to a ${repo.type.toLowerCase()}</button>
        <div id="d-na" ${foldOpen ? '' : 'hidden'}>${folded.map(({ cell, index }) => checkRowHtml(cell, index)).join('')}</div>`
  }

  function curatorActionsHtml(excluded) {
    if (!canCurate) return ''
    const button = excluded
      ? '<button class="btn" type="button" id="unexclude">Remove exclusion</button>'
      : '<button class="btn" type="button" id="exclude-all">Exclude whole component</button>'
    return `<div class="curated">
        <div class="btnrow" style="margin-top:0">
          ${button}
        </div>
        <div id="formhost"></div>
      </div>`
  }

  function drawerBodyHtml(repo) {
    const exclusion = exclusionOf(repo.repository)
    const excluded = !!exclusion
    const checks = cellsOf(repo).map((cell, index) => ({ cell, index }))
    // Not-collected stays in the open list (a gap to close); not-applicable folds away (settled).
    const folded = excluded ? [] : checks.filter(({ cell }) => cell.s === 'na')
    const shown = excluded ? checks : checks.filter(({ cell }) => cell.s !== 'na')

    return `
      ${excluded ? exclusionNoteHtml(exclusion) : ''}
      <p class="d-title">Checks</p>
      ${shown.map(({ cell, index }) => checkRowHtml(cell, index)).join('')}
      ${foldedChecksHtml(repo, folded)}

      <p class="d-title">Ownership</p>
      <div class="facts">
        <div><dt>Team</dt><dd>${repo.owner ? esc(repo.owner) : 'Not set'}</dd></div>
        <div><dt>Technical contact</dt><dd>${repo.contact ? esc(repo.contact) : 'Not set'}</dd></div>
      </div>

      ${curatorActionsHtml(excluded)}`
  }

  function formHtml(form) {
    return `<div class="form">
      <p class="form-h">${form.title}</p>
      ${''}
      <label for="fx-ref">Decision reference <span class="opt">optional</span></label>
      <input id="fx-ref" placeholder="Ticket, document or meeting note" autocomplete="off">
      <label for="fx-why">Reason <span class="opt">optional</span></label>
      <textarea id="fx-why" placeholder="${form.why}"></textarea>
      <div class="err" id="fx-err" role="alert" hidden></div>
      <div class="btnrow">
        <button class="btn primary" type="button" id="fx-save">Save</button>
        <button class="btn" type="button" id="fx-cancel">Cancel</button>
      </div>
    </div>`
  }

  function mountForm(kind) {
    const form = FORMS[kind]
    const host = byId('formhost')
    host.innerHTML = formHtml(form)
    // The form mounts at the bottom of a scrolling sheet, so bring it into view.
    host.scrollIntoView({ block: 'end', behavior: 'smooth' })
    host.querySelector('#fx-cancel').onclick = () => {
      host.innerHTML = ''
    }
    host.querySelector('#fx-save').onclick = () => {
      host.querySelector('#fx-err').hidden = true
      // Who and when are recorded server-side from the session.
      const entry = {
        type: form.entryType,
        component: current.repository,
        ref: host.querySelector('#fx-ref').value.trim(),
        reason: host.querySelector('#fx-why').value.trim(),
      }
      saveDecision(entry, form.doneMessage, host)
    }
    host.querySelector('#fx-ref').focus()
  }

  // A decision is either recorded or it is not: there is no "kept on this page only" state.
  async function saveDecision(entry, doneMessage, host) {
    const repoName = entry.component
    try {
      await recordDecision(entry)
    } catch (error) {
      // Both forms carry one inline `.err` node: the error shows in the form that was submitted.
      const errorNode = host.querySelector('.err')
      errorNode.textContent = error.message
      errorNode.hidden = false
      errorNode.scrollIntoView({ block: 'center' })
      return
    }
    render()
    openDetails(repoName, { keepScroll: true })
    toast(`${doneMessage} — written to the decision log`)
  }

  const tableRows = () => root.querySelectorAll('tbody tr[data-repo]')
  const siblings = () => [...tableRows()].map((row) => row.dataset.repo)

  function drawerSubtitleHtml(repo, total, unscanned, position, count) {
    const archived = repo.archived ? '<span class="arch">archived</span>' : ''
    const status = repo.status ? `<span>${esc(repo.status)}</span>` : ''
    const score = total.of
      ? `<span><b style="color:var(--ink)">${total.met} of ${total.of}</b> applicable checks met${unscanned ? ` · ${unscanned} not collected` : ''}</span>`
      : '<span>Not assessed</span>'
    const place = position > -1 ? `<span>${position + 1} of ${count}</span>` : ''
    return `<span class="kind">${repo.type}</span>${archived}${status}${score}${place}`
  }

  function drawerLinksHtml(repo) {
    const name = esc(repo.repository)
    const githubUrl = repositoryUrl(repo.repository)
    const githubLink = githubUrl
      ? `<a class="iconlink" href="${esc(githubUrl)}" target="_blank" rel="noopener" title="Open ${name} on GitHub" aria-label="Open ${name} on GitHub">${GITHUB_ICON}</a>`
      : ''
    return `
      ${githubLink}
      <a class="iconlink" href="${MAP_URL}?sel=${encodeURIComponent(repo.repository)}" target="_blank" rel="noopener" title="Show ${name} in the Architecture Map" aria-label="Show ${name} in the Architecture Map">${MAP_ICON}</a>`
  }

  function wireDrawerNavigation(order, position) {
    const previous = byId('d-prev')
    const next = byId('d-next')
    previous.disabled = position <= 0
    next.disabled = position < 0 || position >= order.length - 1
    previous.onclick = () => openDetails(order[position - 1])
    next.onclick = () => openDetails(order[position + 1])
  }

  function wireRowEditor(repo) {
    const editor = byId('rowedit')
    if (!editor) return
    editor.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    editor.querySelector('#f-cancel').onclick = () => {
      editing = null
      openDetails(repo.repository, { keepScroll: true })
    }
    editor.querySelector('#f-save').onclick = () => {
      editor.querySelector('#f-err').hidden = true
      const index = +editor.querySelector('#f-save').dataset.i
      const type = editor.querySelector('input[name="f-move"]:checked').value
      editing = null
      const entry = {
        type,
        component: repo.repository,
        check: CHECKS[index].k,
        ref: editor.querySelector('#f-ref').value.trim(),
        reason: editor.querySelector('#f-why').value.trim(),
      }
      saveDecision(entry, MOVE_DONE_MESSAGE[type], editor)
    }
  }

  function wireDrawerBody(repo) {
    const reopen = () => openDetails(repo.repository, { keepScroll: true })
    const fold = byId('d-fold')
    if (fold) {
      fold.onclick = () => {
        foldOpen = !foldOpen
        reopen()
      }
    }
    for (const button of root.querySelectorAll('#d-body [data-edit]')) {
      button.onclick = () => {
        const index = +button.dataset.edit
        editing = editing === index ? null : index
        reopen()
      }
    }
    wireRowEditor(repo)
    byId('unexclude')?.addEventListener('click', () => mountForm('revoke'))
    byId('exclude-all')?.addEventListener('click', () => mountForm('exclude'))
  }

  function markRow(row, open) {
    row.classList.toggle('open', open)
    row.querySelector('.nm').setAttribute('aria-expanded', String(open))
  }

  function markOpenRow(repoName) {
    for (const row of tableRows()) markRow(row, row.dataset.repo === repoName)
    lastRow = root.querySelector(`tbody tr[data-repo="${CSS.escape(repoName)}"]`) || lastRow
  }

  function openDetails(repoName, { keepScroll = false } = {}) {
    const repo = repositories.find((candidate) => candidate.repository === repoName)
    if (!repo) return
    current = repo
    if (!keepScroll) {
      foldOpen = false
      editing = null
    }
    const cells = cellsOf(repo)
    const total = totalOf(cells)
    const order = siblings()
    const position = order.indexOf(repoName)

    byId('d-name').textContent = repo.repository
    byId('d-sub').innerHTML = drawerSubtitleHtml(
      repo,
      total,
      countState(cells, 'unk'),
      position,
      order.length,
    )
    byId('d-apps').textContent = repo.applications.length
      ? repo.applications.join(' · ')
      : 'Not linked to an application'
    byId('d-links').innerHTML = drawerLinksHtml(repo)
    byId('d-body').innerHTML = drawerBodyHtml(repo)
    wireDrawerNavigation(order, position)
    wireDrawerBody(repo)
    markOpenRow(repoName)

    const drawer = byId('drawer')
    const wasOpen = drawer.classList.contains('open')
    drawer.classList.add('open')
    drawer.setAttribute('aria-hidden', 'false')
    if (!wasOpen) byId('d-name').focus()
    else
      announce(`${repo.repository}, ${total.of ? `${total.met} of ${total.of} checks met` : 'not assessed'}`)
    // Stepping through components replaces the entry; only a fresh open pushes, so Back leaves the panel.
    if (history.state?.component !== repoName) writeUrl({ push: !wasOpen, repo: repoName })
    lastRow?.scrollIntoView({ block: 'nearest' })
  }

  function closeDetails(fromPopState) {
    if (!drawerIsOpen()) return
    current = null
    byId('drawer').classList.remove('open')
    byId('drawer').setAttribute('aria-hidden', 'true')
    for (const row of tableRows()) markRow(row, false)
    if (lastRow && root.contains(lastRow)) lastRow.querySelector('.nm').focus()
    if (!fromPopState) writeUrl({ push: true })
  }

  // The row editor (f-*) and the exclusion form (fx-*) can be open at once: find the one that is dirty.
  function dirtyFormCancelButton() {
    for (const prefix of ['f', 'fx']) {
      const reason = byId(`${prefix}-why`)
      const ref = byId(`${prefix}-ref`)
      if ((reason && reason.value.trim()) || (ref && ref.value.trim())) return byId(`${prefix}-cancel`)
    }
    return null
  }

  // First Escape cancels a dirty form; only the next one closes the panel.
  function escapeOnce() {
    const cancel = dirtyFormCancelButton()
    if (cancel) {
      cancel.click()
      toast('Form discarded — press Escape again to close')
      return
    }
    closeDetails()
  }

  function stepThroughRows(event) {
    const order = siblings()
    const position = order.indexOf(current?.repository)
    const isNext = event.key === 'j' || event.key === 'ArrowDown'
    const isPrevious = event.key === 'k' || event.key === 'ArrowUp'
    if (isNext && position > -1 && position < order.length - 1) {
      event.preventDefault()
      openDetails(order[position + 1])
    }
    if (isPrevious && position > 0) {
      event.preventDefault()
      openDetails(order[position - 1])
    }
  }

  function onKeydown(event) {
    if (closeDropdownOnEscape(event)) return
    onDrawerKeydown(event)
  }

  function onDrawerKeydown(event) {
    if (!drawerIsOpen()) return
    if (event.key === 'Escape') {
      escapeOnce()
      return
    }
    if (root.activeElement?.matches('input, textarea, select')) return
    stepThroughRows(event)
  }

  // Non-modal, no scrim: a bare-space click closes, another row switches, a control does neither.
  const KEEPS_DRAWER_OPEN = '#drawer, tr[data-repo], button, a, input, select, textarea, label, .ms'
  function onDocumentMousedown(event) {
    if (!drawerIsOpen()) return
    if (clickedElement(event).closest(KEEPS_DRAWER_OPEN)) return
    escapeOnce()
  }

  function openRow(row) {
    lastRow = row
    openDetails(row.dataset.repo)
  }

  // ── Analytics ─────────────────────────────────────────────────────────────────────────
  // Filters apply to the whole series, so the charts are the history of exactly what the table shows.

  // Both charts read one per-night stat so they can never tell two stories about the same evening.
  function statsOn(night) {
    let stats = statsCache.get(night.d)
    if (!stats) {
      stats = statsForNight(night, { decisionLog, keep: matchesFilters })
      statsCache.set(night.d, stats)
    }
    return stats
  }

  // A night the pipeline did not run is simply absent: the line joins its neighbours, no invented point.
  const nightsIn = (from, to) => nights.filter((night) => night.t >= from && night.t <= to)
  const statsIn = (from, to) => nightsIn(from, to).map(statsOn)
  const rangeGrain = () => bucketDays((range.to - range.from) / DAY_MS)
  // The window's position of `t` along a plot `width` wide inside `padding`.
  const xScale = (width, padding) => (t) =>
    padding.l + ((t - range.from) / (range.to - range.from || 1)) * (width - padding.l - padding.r)

  const tip = byId('tip')
  function showTip(html, x, y) {
    tip.innerHTML = html
    tip.classList.add('on')
    const box = tip.getBoundingClientRect()
    tip.style.left = Math.min(window.innerWidth - box.width - 12, Math.max(12, x - box.width / 2)) + 'px'
    tip.style.top = Math.max(12, y - box.height - 12) + 'px'
  }
  const hideTip = () => tip.classList.remove('on')

  // Pushes end-of-line labels apart so close values don't overprint.
  function spreadEndLabels(latest, y) {
    const ends = TREND_SERIES.map((key) => ({ k: key, yv: y(latest[key]), v: latest[key] })).sort(
      (a, b) => a.yv - b.yv,
    )
    for (let i = 1; i < ends.length; i++) {
      if (ends[i].yv - ends[i - 1].yv < END_LABEL_GAP) ends[i].yv = ends[i - 1].yv + END_LABEL_GAP
    }
    return ends
  }

  function trendLinesHtml(points, x, y) {
    const ends = spreadEndLabels(points[points.length - 1], y)
    return TREND_SERIES.map((key) => {
      const line = points.map((point) => [x(point.t), y(point[key])])
      const [lastX, lastY] = line[line.length - 1]
      const end = ends.find((candidate) => candidate.k === key)
      const color = STATE_COLOR[key]
      return `<path d="${pathThrough(line)}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"
          stroke-linecap="round" ${key === 'unk' ? 'stroke-dasharray="4 4"' : ''}/>
        <circle cx="${lastX}" cy="${lastY}" r="4" fill="${color}" stroke="var(--sur)" stroke-width="2"/>
        <text class="axis" x="${lastX + 9}" y="${end.yv + 4}" fill="${color}">${end.v}</text>`
    }).join('')
  }

  function trendTooltipHtml(point, grain) {
    const from = new Date(point.from)
    const to = new Date(point.to)
    const heading =
      grain === 1
        ? `${dayAndMonth(from)} ${from.getUTCFullYear()}`
        : `${dayAndMonth(from)} – ${dayAndMonth(to)} ${to.getUTCFullYear()} <span style="opacity:.6">· ${grain === 7 ? 'weekly' : 'monthly'} mean</span>`
    const lines = TREND_SERIES.map(
      (key) =>
        `<i style="background:${STATE_COLOR[key]}${key === 'unk' ? ';opacity:.5' : ''}"></i>${STATE_LABEL[key]} <b>${point[key]}</b>`,
    ).join('<br>')
    const applicable = TREND_SERIES.reduce((sum, key) => sum + point[key], 0)
    return (
      `<b>${heading}</b><br>` +
      lines +
      `<br><span style="opacity:.7">of ${applicable} applicable checks</span>`
    )
  }

  // One overlay rect, not per-point hits: at daily resolution a per-point target is 1px wide.
  function wireTrendHover(host, points, grain, width, x) {
    const padding = TREND_PADDING
    const hit = host.querySelector('#hit')
    // Measure the plot's svg via the overlay: the legend swatches are the panel's first SVGs.
    const plot = hit.closest('svg')
    const crosshair = host.querySelector('#xhair')
    hit.onmousemove = (event) => {
      const box = plot.getBoundingClientRect()
      const plotX = ((event.clientX - box.left) / box.width) * width
      const t = range.from + ((plotX - padding.l) / (width - padding.l - padding.r)) * (range.to - range.from)
      const nearest = points.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a))
      crosshair.setAttribute('x1', x(nearest.t))
      crosshair.setAttribute('x2', x(nearest.t))
      crosshair.setAttribute('opacity', '.25')
      showTip(trendTooltipHtml(nearest, grain), event.clientX, box.top + 60)
    }
    hit.onmouseleave = () => {
      crosshair.setAttribute('opacity', '0')
      hideTip()
    }
  }

  function chartTrend() {
    hideTip()
    const grain = rangeGrain()
    const host = byId('ch-trend')
    const daily = statsIn(range.from, range.to)
    if (!daily.length) {
      host.innerHTML = `<h3>Overall state</h3><p class="grain">No nightly run falls inside this window.
        The record starts on ${isoDay(allTimeFrom)}.</p>`
      return
    }
    const points = resample(daily, grain)
    const latest = points[points.length - 1]
    const width = Math.max(TREND_MIN_WIDTH, Math.round(host.clientWidth - 40))
    const height = TREND_HEIGHT
    const padding = TREND_PADDING
    const max = Math.max(...points.flatMap((point) => TREND_SERIES.map((key) => point[key])))
    const top = Math.max(TREND_Y_STEP, Math.ceil(max / TREND_Y_STEP) * TREND_Y_STEP)
    const x = xScale(width, padding)
    const y = (value) => height - padding.b - (value / top) * (height - padding.t - padding.b)
    const horizontal = (value) =>
      `<line class="gridline" x1="${padding.l}" x2="${width - padding.r}" y1="${y(value)}" y2="${y(value)}"/>`

    const steps = Array.from({ length: top / TREND_Y_STEP + 1 }, (_, i) => i * TREND_Y_STEP)
    const grid = steps.map(horizontal).join('')
    const yLabels = steps
      .map(
        (value, i) =>
          `<text class="axis" x="0" y="${y(value) + 3.5}">${value}${i === steps.length - 1 ? ' checks' : ''}</text>`,
      )
      .join('')
    const xLabels = ticksFor(range.from, range.to)
      .map(
        (tick) =>
          `<text class="axis" x="${x(tick.t)}" y="${height - 6}" text-anchor="middle">${tick.label}</text>`,
      )
      .join('')
    const overlay = `<line id="xhair" x1="0" x2="0" y1="${padding.t}" y2="${height - padding.b}" stroke="var(--ink)" stroke-width="1" opacity="0"/>
         <rect id="hit" x="${padding.l}" y="${padding.t}" width="${width - padding.l - padding.r}" height="${height - padding.t - padding.b}" fill="transparent"/>`
    const label = `Checks by state over the selected window. Today: ${TREND_SERIES.map((key) => `${STATE_LABEL[key]} ${latest[key]}`).join(', ')}.`

    host.innerHTML = `
      <h3>Overall state</h3>
      ${legend(TREND_SERIES)}
      ${svgFrame(width, height, grid + yLabels + trendLinesHtml(points, x, y) + horizontal(0) + xLabels + overlay, label)}`

    wireTrendHover(host, points, grain, width, x)
  }

  function rangeBarHtml(spanDays, grain) {
    const presets = Object.entries(RANGES)
      .map(
        ([key, preset]) => `<button type="button" data-range="${key}"
              aria-pressed="${range.key === key}">${preset.label}</button>`,
      )
      .join('')
    const customFields =
      range.key === 'custom' && customRangeOpen
        ? `<div class="customrange">
        <label>From <input type="date" id="r-from" value="${isoDay(range.from)}" max="${isoDay(range.to)}"></label>
        <label>To <input type="date" id="r-to" value="${isoDay(range.to)}" min="${isoDay(range.from)}" max="${isoDay(today)}"></label>
      </div>`
        : ''
    return `
      <div class="rangetop-row">
        <p class="grain">Showing ${Math.round(spanDays)} days ·
          ${grainDescription(grain)}</p>
        <div class="rangewrap" id="rangebar">
          <div class="rangebar">
            ${presets}
          </div>
          <button class="rangecustom" type="button" data-range="custom"
            aria-pressed="${range.key === 'custom'}" aria-expanded="${customRangeOpen}">Custom<span class="car"></span></button>
        </div>
      </div>
      ${customFields}`
  }

  function onRangeButton(event) {
    const button = event.target.closest('button')
    if (!button) return
    if (button.dataset.range === 'custom') {
      // Pressing Custom again folds the form away.
      customRangeOpen = range.key === 'custom' ? !customRangeOpen : true
      range.key = 'custom'
    } else {
      range.key = button.dataset.range
      customRangeOpen = false
      range.from = rangeStart(range.key)
      range.to = today
    }
    redrawAnalytics()
    writeUrl()
  }

  function renderRangeBar() {
    const spanDays = (range.to - range.from) / DAY_MS
    const host = byId('rangetop')
    host.innerHTML = rangeBarHtml(spanDays, bucketDays(spanDays))
    host.querySelector('#rangebar').onclick = onRangeButton

    // A cleared field is Date.parse('') = NaN: fall back to the whole record, like readUrl does.
    const fromField = host.querySelector('#r-from')
    const toField = host.querySelector('#r-to')
    if (fromField) {
      fromField.onchange = () => {
        range.from = Date.parse(fromField.value) || allTimeFrom
        redrawAnalytics()
        writeUrl()
      }
    }
    if (toField) {
      toField.onchange = () => {
        range.to = Date.parse(toField.value) || today
        redrawAnalytics()
        writeUrl()
      }
    }
  }

  const rateOf = ({ met, applicable }) => (applicable ? met / applicable : 0)

  function checkFacet(check, index, windowStats, grain) {
    const { applicable, met } = windowStats[windowStats.length - 1].perCheck[index]
    const daily = windowStats.map((night) => ({ t: night.t, v: rateOf(night.perCheck[index]) }))
    const pts = resampleRates(daily, grain)
    const delta = Math.round((pts[pts.length - 1].v - pts[0].v) * 100)
    return {
      name: check.name,
      applicable,
      met,
      rate: rateOf({ met, applicable }),
      pts,
      delta,
      collected: COLLECTED[check.k],
    }
  }

  // Collected checks first, worst rate first.
  const byCollectedThenRate = (a, b) => (a.collected === b.collected ? a.rate - b.rate : a.collected ? -1 : 1)

  function sparkline(facet) {
    const width = SPARK_WIDTH
    const height = SPARK_HEIGHT
    const padding = SPARK_PADDING
    const x = xScale(width, padding)
    const y = (value) => height - padding.b - (value / SPARK_HEADROOM) * (height - padding.t - padding.b)
    const line = pathThrough(facet.pts.map((point) => [x(point.t), y(point.v)]))
    const last = facet.pts[facet.pts.length - 1]
    const tone = directionColor(facet.delta)
    return svgFrame(
      width,
      height,
      `
        <line class="gridline" x1="${padding.l}" x2="${width - padding.r}" y1="${y(1)}" y2="${y(1)}" stroke-dasharray="2 3"/>
        <path d="${line}" fill="none" stroke="${tone}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${x(last.t)}" cy="${y(last.v)}" r="3.5" fill="${tone}" stroke="var(--sur)" stroke-width="2"/>`,
    )
  }

  function facetHtml(facet) {
    const now = facet.collected
      ? `${Math.round(facet.rate * 100)}% · ${facet.met}/${facet.applicable} ${deltaChip(facet)}`
      : 'not collected yet'
    const chart = facet.collected
      ? sparkline(facet)
      : `<span class="chip unk" style="margin-top:10px">${STATE_ICONS.unk}Not scanned</span>`
    return `<div class="facet${facet.collected ? '' : ' muted'}">
        <h4>${facet.name}</h4>
        <div class="now">${now}</div>
        ${chart}
      </div>`
  }

  const directionKeyHtml = () =>
    DIRECTION_KEY.map(
      ([color, label]) =>
        `<span><svg class="swatch" viewBox="0 0 16 8" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4"
            stroke="${color}" stroke-width="2" stroke-linecap="round"/></svg>${label}</span>`,
    ).join('')

  // Small multiples, one per rule: which rule is not landing. Same window and grain as the trend chart.
  function chartChecks() {
    const grain = rangeGrain()
    const host = byId('ch-checks')
    const windowStats = statsIn(range.from, range.to)
    if (!windowStats.length) {
      host.innerHTML = '<h3>State by rule</h3><p class="grain">No nightly run in this window.</p>'
      return
    }
    const facets = CHECKS.map((check, index) => checkFacet(check, index, windowStats, grain))
    facets.sort(byCollectedThenRate)

    host.innerHTML = `
      <h3>State by rule</h3>
      <div class="legend-row dir-key">
        <span>Change over the window:</span>
        ${directionKeyHtml()}
        <span class="key-note">colour is direction here, not state</span>
      </div>
      <div class="facets">${facets.map(facetHtml).join('')}</div>`
  }

  function redrawAnalytics() {
    renderRangeBar()
    chartTrend()
    chartChecks()
  }

  function renderAnalytics() {
    statsCache = new Map() // filters or a curated decision change every night at once
    redrawAnalytics()
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────────────────

  function setTab(name) {
    const analytics = name === 'analytics'
    state.tab = analytics ? 'analytics' : 'table'
    for (const button of root.querySelectorAll('#tabs button')) {
      const selected = button.dataset.tab === state.tab
      button.setAttribute('aria-selected', String(selected))
      button.tabIndex = selected ? 0 : -1
    }
    byId('analytics').hidden = !analytics
    byId('view-table').hidden = analytics
    hideTip()
    if (analytics) {
      closeDetails()
      renderAnalytics()
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────────────────────────

  function onPopState(event) {
    // Restore the whole view before the panel: openDetails would otherwise overwrite the entry being restored.
    readUrl()
    syncControls()
    render()
    setTab(state.tab)
    if (event.state?.component) openDetails(event.state.component)
    else closeDetails(true)
  }

  function onFilterButton(event) {
    const button = event.target.closest('button')
    if (!button) return
    state.filter = button.dataset.f
    for (const other of root.querySelectorAll('#seg button')) {
      other.setAttribute('aria-pressed', String(other === button))
    }
    render()
    writeUrl()
  }

  // Arrow keys, Home and End move between tabs and select the one they land on.
  function tabPositionFor(key, index, count) {
    if (key === 'ArrowRight') return (index + 1) % count
    if (key === 'ArrowLeft') return (index - 1 + count) % count
    if (key === 'Home') return 0
    if (key === 'End') return count - 1
    return -1
  }

  function onTabKeydown(event) {
    const tabs = [...root.querySelectorAll('#tabs [role="tab"]')]
    const position = tabPositionFor(event.key, tabs.indexOf(event.target), tabs.length)
    if (position < 0) return
    event.preventDefault()
    tabs[position].focus()
    tabs[position].click()
  }

  function onTabButton(event) {
    const button = event.target.closest('button')
    if (!button || button.dataset.tab === state.tab) return
    setTab(button.dataset.tab)
    // A tab is a move between two views, not a refinement of one: Back should return to the other.
    writeUrl({ push: true })
  }

  setTheme(localStorage.getItem(THEME_KEY) || 'system')
  byId('theme').onclick = (event) => {
    const button = event.target.closest('button')
    if (button) setTheme(button.dataset.t)
  }

  listen(document, 'click', (event) => {
    if (!clickedElement(event).closest('.ms')) closeAllDropdowns()
  })
  listen(document, 'mousedown', onDocumentMousedown)
  listen(document, 'keydown', onKeydown)
  listen(window, 'popstate', onPopState)
  byId('d-close').onclick = () => escapeOnce()

  byId('tbl').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-repo]')
    if (row) openRow(row)
  })

  byId('seg').onclick = onFilterButton
  byId('segments').onchange = onSegmentChange
  byId('grp').onchange = (event) => {
    state.group = event.target.checked
    render('settings')
    writeUrl()
  }
  const settings = byId('settings')
  settings.querySelector('.ms-btn').onclick = () => toggleDropdown(settings)
  byId('q').oninput = (event) => {
    state.q = event.target.value
    render()
    writeUrl()
  }

  // The sticky table header needs the bar's REAL height, which changes for more reasons than a resize.
  const topBarObserver = new ResizeObserver(([entry]) => {
    // getBoundingClientRect, not contentRect: the bar's padding and border also cover the table.
    const height = Math.round(entry.target.getBoundingClientRect().height)
    hostEl.style.setProperty('--top-h', `${height}px`)
  })
  topBarObserver.observe(root.querySelector('.top'))

  // Redraw on resize: letting the SVG stretch would scale the axis type with it.
  listen(window, 'resize', () => {
    if (byId('analytics').hidden) return
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(renderAnalytics, RESIZE_DEBOUNCE_MS)
  })
  byId('tabs').onclick = onTabButton
  byId('tabs').onkeydown = onTabKeydown

  // A seam for QA, not an API; dropped from the production bundle.
  if (import.meta.env.DEV) {
    window.GP = {
      get DATA() {
        return repositories
      },
      get HISTORY() {
        return nights
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

  function firstPaint() {
    renderProvenance()
    // readUrl needs the loaded history for the analytics window, so it cannot run earlier.
    readUrl()
    syncControls()
    render()
    if (state.tab === 'analytics') setTab('analytics')
    const deepLinked = new URLSearchParams(location.search).get('component')
    if (deepLinked && repositories.some((repo) => repo.repository === deepLinked)) openDetails(deepLinked)
  }

  function showLoadError(error) {
    byId('tbl').innerHTML =
      `<tbody><tr><td style="padding:40px;text-align:center;color:var(--faint)">${esc(error.message)}</td></tr></tbody>`
  }

  // First paint waits for the decision log too, or approved deviations would show as open.
  Promise.all([loadHistory(), loadDecisionLog(), loadRules()]).then(firstPaint).catch(showLoadError)

  return () => {
    removers.forEach((remove) => remove())
    topBarObserver.disconnect()
    clearTimeout(toastTimer)
    clearTimeout(resizeTimer)
    if (import.meta.env.DEV) delete window.GP
  }
}
