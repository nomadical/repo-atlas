// Tests for the data guard's pure validate(). Run with `node --test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validate, CORE, MIN_REPOS, MIN_INVENTORY } from './guard-data.mjs'

// CORE / MIN_* come from config.json, so these fixtures derive from them rather than naming any
// particular estate's repos — the tests hold for whatever tripwires a fork configures, including
// none. A core repo to remove in the coverage test, invented when none are configured.
const CORE_SAMPLE = CORE[0] || 'core-repo'
const REPO_COUNT = Math.max(MIN_REPOS, CORE.length + 2)
const EXTRA_REPOS = Array.from({ length: REPO_COUNT - CORE.length }, (_, i) => `extra-repo-${i}`)

// A minimal "healthy" dataset: all core repos present (+ extras to clear MIN_REPOS), inventory
// padded past MIN_INVENTORY with fully-curated synthetic components, clean edges + topics.
const healthy = () => ({
  generatedAt: new Date().toISOString(),
  repos: [...CORE, CORE_SAMPLE, ...EXTRA_REPOS].filter((f, i, a) => a.indexOf(f) === i).map((folder) => ({ folder })),
  inventory: [
    { name: 'ui', type: 'Library', status: 'Current', owner: 'Platform' },
    { name: 'Payments', type: 'Third-Party Service', status: 'Current', owner: 'Storefront' },
    ...Array.from({ length: MIN_INVENTORY }, (_, i) => ({ name: `component-${i}`, type: 'Service', status: 'Current', owner: 'Platform' })),
  ],
  integrations: [{ source: 'ui', target: 'Kafka', protocol: 'Kafka' }],
  uiConsumers: [{ repo: EXTRA_REPOS[0] || CORE_SAMPLE, version: '1.0.0' }],
})

test('healthy data passes with no errors', () => {
  const { errors, warnings } = validate(healthy())
  assert.deepEqual(errors, [])
  assert.deepEqual(warnings, [])
})

test('missing a core repo is an error', { skip: CORE.length ? false : 'no coreRepos configured' }, () => {
  const d = healthy()
  d.repos = d.repos.filter((r) => r.folder !== CORE_SAMPLE)
  const { errors } = validate(d)
  assert.ok(errors.some((e) => e.includes('missing core repos') && e.includes(CORE_SAMPLE)))
})

test('too few repos is an error', { skip: MIN_REPOS ? false : 'no minRepos configured' }, () => {
  const { errors } = validate({ repos: [{ folder: CORE_SAMPLE }] })
  assert.ok(errors.some((e) => e.includes(`min ${MIN_REPOS}`)))
})

test('an inventory collapse is an error (topics stripped)', () => {
  const d = healthy()
  d.inventory = d.inventory.slice(0, 2)
  const { errors } = validate(d)
  assert.ok(errors.some((e) => e.includes(`min ${MIN_INVENTORY}`)))
})

test('empty integrations is an error (lost CSV / derivation inputs)', () => {
  const d = healthy()
  d.integrations = []
  const { errors } = validate(d)
  assert.ok(errors.some((e) => e.includes('integrations is empty')))
})

test('freshness: stale generatedAt fails only when maxAgeHours is requested', () => {
  const d = healthy()
  d.generatedAt = new Date(Date.now() - 48 * 3600000).toISOString()
  assert.deepEqual(validate(d).errors, []) // no opt-in -> committed old data stays valid
  const { errors } = validate(d, null, { maxAgeHours: 12 })
  assert.ok(errors.some((e) => e.includes('generatedAt') && e.includes('max 12h')))
  assert.deepEqual(validate(healthy(), null, { maxAgeHours: 12 }).errors, []) // fresh passes
})

test('freshness: missing generatedAt fails when maxAgeHours is requested', () => {
  const d = healthy()
  delete d.generatedAt
  const { errors } = validate(d, null, { maxAgeHours: 12 })
  assert.ok(errors.some((e) => e.includes('generatedAt is missing')))
})

test('a service link to an unknown source is an error', () => {
  const d = healthy()
  d.integrations.push({ source: 'ghost-repo', target: 'Kafka' })
  const { errors } = validate(d)
  assert.ok(errors.some((e) => e.includes('ghost-repo') && e.includes('not a known node')))
})

test('a design-system consumer that is not a present repo is an error', () => {
  const d = healthy()
  d.uiConsumers.push({ repo: 'not-a-repo' })
  const { errors } = validate(d)
  assert.ok(errors.some((e) => e.includes('not-a-repo')))
})

test('a valid (type, subtype) pair passes; unknown or mismatched subtype is an error', () => {
  const ok = healthy()
  ok.inventory.push({ name: 'conn', type: 'Service', subtype: 'Connector', status: 'Current', owner: 'Platform' })
  assert.deepEqual(validate(ok).errors, [])
  const typo = healthy()
  typo.inventory.push({ name: 'x', type: 'Service', subtype: 'Connecter', status: 'Current', owner: 'Platform' })
  assert.ok(validate(typo).errors.some((e) => e.includes('unknown subtype') && e.includes('Connecter')))
  const mismatch = healthy()
  mismatch.inventory.push({ name: 'y', type: 'Library', subtype: 'Worker', status: 'Current', owner: 'Platform' })
  assert.ok(validate(mismatch).errors.some((e) => e.includes('not valid for type "Library"')))
})

test('an unknown closed-enum status is an error (typo guard)', () => {
  const d = healthy()
  d.inventory[0].status = 'Currnet'
  const { errors } = validate(d)
  assert.ok(errors.some((e) => e.includes('unknown status') && e.includes('Currnet')))
})

test('an unknown owner is a warning, not an error (open set)', () => {
  const d = healthy()
  d.inventory[0].owner = 'NEWTEAM'
  const { errors, warnings } = validate(d)
  assert.equal(errors.length, 0)
  assert.ok(warnings.some((w) => w.includes('NEWTEAM')))
})

test('half-curated components are summarized into one warning (not one per component)', () => {
  const d = healthy()
  d.inventory.push({ name: 'half-a', type: 'Client', repoName: 'half-a' })
  d.inventory.push({ name: 'half-b', type: 'Client', repoName: 'half-b', owner: 'Storefront' }) // missing status+description
  const { errors, warnings } = validate(d)
  assert.equal(errors.length, 0)
  const summary = warnings.filter((w) => w.includes('half-curated'))
  assert.equal(summary.length, 1, 'a single summary line, not one per component')
  assert.ok(summary[0].includes('2 components half-curated'))
  assert.ok(summary[0].includes('missing description')) // breakdown present
})

test('a repo missing its folder is a structural error', () => {
  const d = healthy()
  d.repos.push({ kind: 'client' }) // no folder
  const { errors } = validate(d)
  assert.ok(errors.some((e) => e.includes('missing its folder')))
})

test('an inventory component missing its name is a structural error', () => {
  const d = healthy()
  d.inventory.push({ type: 'Service' }) // no name
  const { errors } = validate(d)
  assert.ok(errors.some((e) => e.includes('missing its name')))
})

test('an inventory source resolves a non-repo third-party node', () => {
  const d = healthy()
  d.integrations.push({ source: 'Payments', target: 'Kafka' }) // Payments is inventory-only
  const { errors } = validate(d)
  assert.equal(errors.length, 0)
})

test('flags an FE apiUrl host with no backend node (soft, warning)', () => {
  const d = healthy()
  d.backendTopology = { backends: [{ id: 'be1', label: 'Core', host: 'api.known.com' }] }
  d.repos.push({ folder: 'newapp', apiUrl: 'api.unknown.com' })
  const { errors, warnings } = validate(d)
  assert.deepEqual(errors, []) // soft: never blocks
  assert.ok(warnings.some((w) => w.includes('newapp') && w.includes('no backend node')))
})

test('does not flag an apiUrl host that matches a backend (env-normalized)', () => {
  const d = healthy()
  d.backendTopology = { backends: [{ id: 'be1', label: 'Core', host: 'api.{env}.known.com' }] }
  d.repos.push({ folder: 'newapp', apiUrl: 'api.prod.known.com' })
  const { warnings } = validate(d)
  assert.ok(!warnings.some((w) => w.includes('newapp')))
})

test('serviceRepo pointing at a missing repo is an error (#16)', () => {
  const d = healthy()
  d.inventory.push({ name: 'telemetry-read', serviceId: 'telemetry-read', serviceRepo: 'no-such-repo' })
  const { errors } = validate(d)
  assert.ok(errors.some((e) => e.includes('serviceRepo') && e.includes('no-such-repo')))
})

test('a serviceRepo that resolves to a present repo passes (#16)', () => {
  const d = healthy()
  d.repos.push({ folder: 'telemetry-service' })
  d.inventory.push({ name: 'telemetry-read', serviceId: 'telemetry-read', serviceRepo: 'telemetry-service' })
  const { errors } = validate(d)
  assert.deepEqual(errors, [])
})

test('entries without serviceRepo still validate (pre-migration data, #16)', () => {
  const { errors } = validate(healthy())
  assert.deepEqual(errors, [])
})

test('serviceRepo may name an owning repo known only via inventory repoName, not a drawn folder (#16)', () => {
  const d = healthy()
  d.inventory.push({ name: 'telemetry-write', repoName: 'telemetry-service' }) // repo not cloned/drawn
  d.inventory.push({ name: 'telemetry-read', serviceRepo: 'telemetry-service' })
  const { errors } = validate(d)
  assert.deepEqual(errors, [])
})
