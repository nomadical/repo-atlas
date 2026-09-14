// Tests for inventory.mjs's parsing primitives — the hand-rolled CSV parser and the topic
// parser feed everything downstream (integrations, third-party meta, the whole Component
// Inventory), so regressions here silently reshape the map. Run with `node --test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv, parseTopics, loadIntegrations, TOPIC_MAPS } from './inventory.mjs'

// ---- parseCsv (RFC-4180) --------------------------------------------------------------

test('parseCsv: plain rows', () => {
  assert.deepEqual(parseCsv('a,b,c\nd,e,f\n'), [['a', 'b', 'c'], ['d', 'e', 'f']])
})

test('parseCsv: quoted field with embedded comma', () => {
  assert.deepEqual(parseCsv('a,"b, with comma",c\n'), [['a', 'b, with comma', 'c']])
})

test('parseCsv: "" escapes inside quotes', () => {
  assert.deepEqual(parseCsv('a,"say ""hi""",c\n'), [['a', 'say "hi"', 'c']])
})

test('parseCsv: embedded newline inside quotes', () => {
  assert.deepEqual(parseCsv('a,"two\nlines",c\n'), [['a', 'two\nlines', 'c']])
})

test('parseCsv: CRLF line endings', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']])
})

test('parseCsv: blank rows are dropped, missing trailing newline kept', () => {
  assert.deepEqual(parseCsv('a,b\n\n,\nc,d'), [['a', 'b'], ['c', 'd']])
})

// ---- parseTopics ----------------------------------------------------------------------

test('parseTopics: type/status map to canonical display values', () => {
  const t = parseTopics(['type-service', 'status-current'])
  assert.equal(t.type, 'Service')
  assert.equal(t.status, 'Current')
})

// owner/app are YOUR vocabulary (config.json `owners` / `applications`) rather than a built-in
// enum, so these assert the mapping mechanism against whatever is configured — including nothing.
test('parseTopics: a configured owner/app slug resolves to its declared display name', () => {
  const [ownerName, ownerSlug] = Object.entries(TOPIC_MAPS.owner)[0] || []
  if (ownerName) assert.equal(parseTopics([ownerSlug]).owner, ownerName)

  const [appName, appSlug] = Object.entries(TOPIC_MAPS.app)[0] || []
  if (appName) {
    // Guards the one-product-two-names split: the canonical value must match what the viz label
    // maps (config `productTags` / `applicationLabels`) and inventory-extra nonRepo entries use.
    assert.deepEqual(parseTopics([appSlug]).applications, [appName])
  }
})

test('parseTopics: subtype-* parses to its display value; unknown subtype slug title-cases for the guard to reject', () => {
  assert.equal(parseTopics(['subtype-connector']).subtype, 'Connector')
  assert.equal(parseTopics(['subtype-framework']).subtype, 'Framework')
  assert.equal(parseTopics(['subtype-widget']).subtype, 'Widget') // unknown → guard errors, not a silent no-op
})

test('parseTopics: unknown app slug title-cases; unknown owner upper-cases dashes to dots', () => {
  const t = parseTopics(['app-fleet-ops', 'owner-new-team'])
  assert.deepEqual(t.applications, ['Fleet Ops'])
  assert.equal(t.owner, 'NEW.TEAM')
})

test('parseTopics: cluster override — a configured label keeps its casing, unknown title-cases', () => {
  // A configured cluster survives the round-trip through a lowercase topic slug ('IoT' → 'cluster-iot'
  // → 'IoT'); anything unrecognised title-cases, so a new cluster works before it's configured.
  assert.equal(parseTopics(['cluster-some-new-area']).cluster, 'Some New Area')
})

test('parseTopics: unrelated topics are ignored', () => {
  const t = parseTopics(['react', 'arch-map-ignore'])
  assert.deepEqual(t, { type: null, subtype: null, status: null, owner: null, applications: [], cluster: null })
})

// ---- loadIntegrations (reads the repo's real integrations.csv) --------------------------

test('loadIntegrations: real CSV parses into non-empty source/target rows', () => {
  const rows = loadIntegrations()
  assert.ok(rows.length > 0, 'integrations.csv produced zero rows — header/BOM regression?')
  for (const r of rows) {
    assert.ok(r.source && r.target, `row missing source/target: ${JSON.stringify(r)}`)
    assert.ok(['REST', 'Kafka'].includes(r.protocol), `unexpected protocol: ${r.protocol}`)
    assert.equal(typeof r.verified, 'boolean')
  }
})

test('loadIntegrations: "— VERIFY" notes mark rows unverified', () => {
  const rows = loadIntegrations()
  for (const r of rows) if (/verify/i.test(r.note)) assert.equal(r.verified, false)
})
