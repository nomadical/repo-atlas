/* Tests for the Golden Path screen's logic: the pure modules under golden-path/lib, read against
   the real history.json and exceptions.jsonl. Nothing here touches the DOM — the interface lives in
   viz/src/golden-path/ and is covered by the viz lint and build. Run with `node --test`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { CHECKS, cellsOf, totalOf, RULES, setRules } from '../lib/rules.mjs'
import { replay, validateEntry, buildEntry } from '../lib/decision-log.mjs'
import { SEGMENTS, segmentOf, segmentCounts } from '../lib/segments.mjs'
import { expandHistory } from '../lib/history.mjs'

const here = (relativePath) => fileURLToPath(new URL(relativePath, import.meta.url))
const readJson = (relativePath) => JSON.parse(readFileSync(here(relativePath), 'utf8'))

// Judge against the committed standards document, exactly as the page does — without this the
// module-level fallback (every type out of scope) applies and the scoring tests prove nothing.
setRules(readJson('../rules.json'))

const FILE = readJson('../history.json')
// Blank lines and an entirely empty log are normal — a fresh install has made no decisions yet —
// so filter before parsing rather than handing JSON.parse an empty string.
const DECISION_LOG = replay(
  readFileSync(here('../exceptions.jsonl'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line)),
)
const NIGHTS = expandHistory(structuredClone(FILE))
const LAST = NIGHTS.at(-1)
const ROWS = Object.values(LAST.rows)
const BUILD = CHECKS.findIndex((check) => check.k === 'build')

// ── 1. segments partition the estate ──────────────────────────────────────────────────────────

/* These run against the real history.json, which the nightly job rewrites — so they assert
   invariants that hold at any size, never today's numbers. An exact repository count here would
   turn a normal night (a repo created or archived) into a red CI on somebody else's pull request. */
test('segmentCounts sums to the whole estate and every row lands in exactly one segment', () => {
  const counts = segmentCounts(ROWS, DECISION_LOG, LAST.d)
  const sum = Object.values(counts).reduce((a, b) => a + b, 0)
  // A non-empty estate is the only size claim that holds for every fork. guard-history.mjs is
  // where a collapse is actually caught, against the previous night rather than a literal.
  assert.ok(
    ROWS.length > 0,
    `the estate collapsed to ${ROWS.length} rows on ${LAST.d} — guard-history should have caught this`,
  )
  assert.equal(
    sum,
    ROWS.length,
    `segment counts ${JSON.stringify(counts)} sum to ${sum}, estate is ${ROWS.length}`,
  )
  for (const estateRow of ROWS) {
    const claiming = SEGMENTS.filter((segment) => segment.is(estateRow, DECISION_LOG, LAST.d)).map(
      (segment) => segment.k,
    )
    const chosen = segmentOf(estateRow, DECISION_LOG, LAST.d)
    assert.ok(
      claiming.includes(chosen),
      `${estateRow.repository}: segmentOf said ${chosen} but no segment claims it`,
    )
    assert.equal(counts[chosen] > 0, true, `${estateRow.repository}: segment ${chosen} missing from counts`)
  }
})

/* Synthetic rows on purpose: this is the ordering rule itself, and pinning it to real repositories
   would make it fail the day somebody archives one or revokes an exclusion — a curated decision
   breaking a logic test. The decision log below is built here for the same reason. */
test('segment resolution order: archived beats everything, applicable is last', () => {
  const decisionLog = replay([
    { ts: '2020-01-01T00:00:00Z', type: 'exclusion', component: 'excluded-service' },
  ])
  const cases = [
    [{ repository: 'archived-and-untyped', type: 'Unclassified', archived: true }, 'archived'],
    [{ repository: 'archived-client', type: 'Client', archived: true }, 'archived'],
    [{ repository: 'excluded-service', type: 'Service' }, 'excluded'],
    // Archived wins even over a curated exclusion: a dead repository is not a compliance question.
    [{ repository: 'excluded-service', type: 'Service', archived: true }, 'archived'],
    [{ repository: 'firmware-thing', type: 'Firmware' }, 'out-of-scope'],
    [{ repository: 'no-topic', type: 'Unclassified' }, 'unclassified'],
    [{ repository: 'plain-service', type: 'Service' }, 'applicable'],
  ]
  for (const [row, want] of cases) {
    assert.equal(
      segmentOf(row, decisionLog, '2026-01-01'),
      want,
      `${row.repository} should be in segment ${want}`,
    )
  }
})

// ── 2. met + unmet = applicable, on every row ────────────────────────────────────────────────

test('totalOf agrees with the cells it counted, on every row', () => {
  for (const estateRow of ROWS) {
    const name = estateRow.repository
    const cells = cellsOf(estateRow, DECISION_LOG, LAST.d)
    const { met, of } = totalOf(cells)
    const applicable = cells.filter((cell) => cell.s !== 'na').length
    const conforming = cells.filter((cell) => cell.s === 'ok' || cell.s === 'dev').length
    assert.equal(of, applicable, `${name}: of=${of} but ${applicable} cells are not na`)
    assert.equal(met, conforming, `${name}: met=${met} but ${conforming} cells are ok/dev`)
    assert.ok(met <= of, `${name}: met=${met} exceeds of=${of}`)
    assert.equal(cells.length, CHECKS.length, `${name}: expected ${CHECKS.length} cells, got ${cells.length}`)
  }
})

/* Library is 0 on purpose: the standards document describes applications and backend services,
   says nothing about shared libraries, and says explicitly that what it does not describe is at the
   team's discretion. See the note in golden-path/rules.json. */
test('applicable checks per kind follow rules.json — a type with no rules is out of scope', () => {
  // Derived from the rules document rather than restated here: a type's applicable-check count IS
  // the number of rules it carries, and a type the document says nothing about must score zero
  // rather than fail everything. Restating the numbers would just duplicate rules.json.
  const rulesPerType = Object.fromEntries(
    Object.entries(RULES).map(([type, typeRules]) => [type, Object.keys(typeRules).length]),
  )
  for (const estateRow of ROWS) {
    // No decision log: the rules alone decide what is applicable.
    const { of } = totalOf(cellsOf(estateRow))
    const expected = rulesPerType[estateRow.type] ?? 0
    assert.equal(
      of,
      expected,
      `${estateRow.repository} (${estateRow.type}): ${of} applicable checks, expected ${expected}`,
    )
  }
})

// ── 3. a curated decision does not act before its own date ───────────────────────────────────

// A repository whose build cell is genuinely `bad` — picked from the data rather than named, so
// the group keeps working when the estate changes. The next test asserts the pick is sound.
const REPO = Object.keys(LAST.rows).find((name) => cellsOf(LAST.rows[name])[BUILD]?.s === 'bad')
const row = () => LAST.rows[REPO]
const entry = (type, extra) => ({
  ts: '2026-07-01T09:00:00.000Z',
  type,
  component: REPO,
  author: 'tester',
  ref: 'ADR-1',
  reason: 'because',
  ...extra,
})

test('the build cell really is bad without any decision (the fixture this group leans on)', () => {
  assert.ok(REPO, 'no repository has a failing build cell — the asOf tests below would prove nothing')
  assert.equal(
    cellsOf(row())[BUILD].s,
    'bad',
    `${REPO}: build cell must be bad for the asOf tests to mean anything`,
  )
})

test('deviation applies from its date onwards, never before', () => {
  const decisionLog = replay([entry('deviation', { check: 'build' })])
  assert.equal(
    cellsOf(row(), decisionLog, '2026-06-30')[BUILD].s,
    'bad',
    'the night before the decision must still read bad',
  )
  const after = cellsOf(row(), decisionLog, '2026-07-02')[BUILD]
  assert.equal(after.s, 'dev', 'the night after the decision must read dev')
  assert.equal(after.audit.at, '2026-07-01', 'the dev cell carries the decision date')
  assert.equal(after.audit.by, 'tester')
  assert.equal(
    cellsOf(row(), decisionLog)[BUILD].s,
    'dev',
    'with no asOf (latest night) the decision applies',
  )
})

test('exclusion applies from its date onwards and covers every check', () => {
  const decisionLog = replay([entry('exclusion')])
  const before = cellsOf(row(), decisionLog, '2026-06-30')
  assert.ok(
    before.every((cell) => !cell.excluded),
    'the night before the exclusion nothing is excluded',
  )
  assert.equal(before[BUILD].s, 'bad', 'and the build cell still reads bad')
  for (const asOf of ['2026-07-02', undefined]) {
    const cells = cellsOf(row(), decisionLog, asOf)
    assert.equal(cells.length, CHECKS.length)
    cells.forEach((cell, i) => {
      const check = CHECKS[i].k
      assert.equal(cell.s, 'na', `asOf=${asOf}: check ${check} should be na under an exclusion`)
      assert.equal(cell.excluded, true, `asOf=${asOf}: check ${check} should be flagged excluded`)
      assert.equal(cell.audit.at, '2026-07-01', `asOf=${asOf}: check ${check} should carry the audit`)
    })
    assert.deepEqual(totalOf(cells), { met: 0, of: 0 }, `asOf=${asOf}: an excluded row counts nothing`)
  }
})

test('revoke cancels the decision it names', () => {
  const revoked = { ts: '2026-07-05T09:00:00.000Z', type: 'revoke', component: REPO, author: 'tester' }
  const exclusion = replay([entry('exclusion'), revoked])
  assert.equal(cellsOf(row(), exclusion)[BUILD].s, 'bad', 'a revoked exclusion leaves the row assessed again')
  assert.ok(!cellsOf(row(), exclusion).some((cell) => cell.excluded), 'no cell stays flagged excluded')
  const deviation = replay([entry('deviation', { check: 'build' }), { ...revoked, check: 'build' }])
  assert.equal(cellsOf(row(), deviation)[BUILD].s, 'bad', 'a revoked deviation leaves the cell bad')
})

test('revoke is not retroactive: nights before the revoke keep the decision', () => {
  const revoked = { ts: '2026-07-05T09:00:00.000Z', type: 'revoke', component: REPO, author: 'tester' }
  const deviation = replay([entry('deviation', { check: 'build' }), { ...revoked, check: 'build' }])
  assert.equal(
    cellsOf(row(), deviation, '2026-07-03')[BUILD].s,
    'dev',
    'a night between approval and revoke still reads dev',
  )
  assert.equal(
    cellsOf(row(), deviation, '2026-07-05')[BUILD].s,
    'bad',
    'from the revoke day the cell is open again',
  )
  const exclusion = replay([entry('exclusion'), revoked])
  assert.equal(
    cellsOf(row(), exclusion, '2026-07-03')[BUILD].s,
    'na',
    'a night before the revoke keeps the exclusion',
  )
})

test('a component named __proto__ is a decision log key, not a prototype write', () => {
  const decisionLog = replay([
    { ts: '2026-07-01T00:00:00.000Z', type: 'exclusion', component: '__proto__', author: 't' },
  ])
  assert.ok(decisionLog.excluded['__proto__'], 'the exclusion is recorded under its own name')
  assert.equal(Object.getPrototypeOf({}), Object.prototype, 'Object.prototype is untouched')
})

test('validateEntry refuses a check that is not a plain identifier', () => {
  assert.ok(validateEntry({ type: 'deviation', component: 'x', check: ['db', 'log'] }), 'array check refused')
  assert.ok(validateEntry({ type: 'deviation', component: 'x', check: 'db,log' }), 'comma check refused')
  assert.equal(
    validateEntry({ type: 'deviation', component: 'x', check: 'build' }),
    null,
    'a real check id passes',
  )
})

test('not-applicable is curated, dated, and drops out of the denominator', () => {
  const decisionLog = replay([entry('not-applicable', { check: 'build' })])
  assert.equal(cellsOf(row(), decisionLog, '2026-06-30')[BUILD].s, 'bad', 'not before its date')
  const cells = cellsOf(row(), decisionLog, '2026-07-02')
  assert.equal(cells[BUILD].s, 'na')
  assert.equal(cells[BUILD].curated, true, 'the na cell says it was curated, not rule-driven')
  assert.equal(totalOf(cells).of, 5, 'one curated exemption shrinks the denominator by one')
})

// ── 4. expanding the nightly history ─────────────────────────────────────────────────────────

test('expandHistory: one night per entry, dates strictly increasing, estate intact at the end', () => {
  assert.equal(NIGHTS.length, FILE.history.length, 'one night per history entry')
  NIGHTS.forEach((night, i) => {
    assert.equal(night.d, FILE.history[i].date, `night ${i} kept its date`)
    assert.equal(night.t, Date.parse(night.d), `night ${night.d} has a parsed timestamp`)
    if (i === 0) return
    const previous = NIGHTS[i - 1].d
    assert.ok(previous < night.d, `dates must strictly increase: ${previous} then ${night.d}`)
  })
  assert.equal(
    Object.keys(LAST.rows).length,
    ROWS.length,
    `last night (${LAST.d}) should hold the whole estate`,
  )
})

test('expandHistory: the replayed last night equals a flat merge of every changed map', () => {
  // Independent build: merge all patches in order, then drop whatever ended up null. Different
  // code path from the incremental replay, so a bug in either one shows up here.
  const merged = Object.assign({}, ...FILE.history.map((night) => night.changed))
  for (const name of Object.keys(merged)) {
    if (merged[name] === null) delete merged[name]
  }
  assert.deepEqual(Object.keys(LAST.rows).sort(), Object.keys(merged).sort(), 'same set of repositories')
  for (const name of Object.keys(merged)) {
    assert.deepEqual(LAST.rows[name], merged[name], `${name}: replayed row differs from the merged row`)
  }
})

test('validateEntry: what may enter the append-only log', () => {
  assert.equal(validateEntry({ type: 'exclusion', component: 'repo' }), null)
  assert.match(validateEntry({ type: 'nonsense', component: 'repo' }), /type must be/)
  assert.match(
    validateEntry({ type: 'exclusion', component: '   ' }),
    /component is required/,
    'whitespace is not a component',
  )
  assert.match(validateEntry({ type: 'deviation', component: 'repo' }), /check is required/)
  assert.match(
    validateEntry({ type: 'exclusion', component: 'repo', reason: 'x'.repeat(2001) }),
    /at most 2000/,
    'an oversized field can never be edited out of an append-only file',
  )
  assert.equal(buildEntry({ type: 'exclusion', component: '  repo  ' }, 'me').component, 'repo')
})

test('expandHistory: a null in changed removes the repository from later nights', () => {
  const removals = FILE.history.flatMap((night, i) =>
    Object.keys(night.changed)
      .filter((name) => night.changed[name] === null)
      .map((name) => [i, name]),
  )
  const cameBack = (j, repo) =>
    Object.keys(FILE.history[j].changed).includes(repo) && FILE.history[j].changed[repo] !== null
  // A history with no removals yet is normal, not a broken fixture — an estate can go months
  // without losing a repository. The loop below is the assertion; nothing to check is a pass.
  if (!removals.length) return
  for (const [i, repo] of removals) {
    assert.ok(
      NIGHTS[i - 1].rows[repo],
      `${repo} should be present on ${NIGHTS[i - 1].d}, the night before it was removed`,
    )
    for (let j = i; j < NIGHTS.length; j++) {
      if (cameBack(j, repo)) break
      assert.ok(
        !(repo in NIGHTS[j].rows),
        `${repo} should be gone on ${NIGHTS[j].d} (removed on ${NIGHTS[i].d})`,
      )
    }
  }
})

test('parseLines keeps valid JSONL entries and skips malformed lines', async () => {
  const { parseLines } = await import('../lib/store.mjs')
  const entries = parseLines('{"a":1}\nnot json\n\n{"b":2}\n')
  assert.deepEqual(entries, [{ a: 1 }, { b: 2 }])
})
