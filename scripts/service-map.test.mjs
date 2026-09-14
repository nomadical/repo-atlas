// Tests for the service<->repo identity resolver (backlog #16). Run with `node --test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serviceIdentity, loadServiceMap } from './service-map.mjs'

const AUDIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('identity default: repo-backed component is its own service, owned by its repo', () => {
  assert.deepEqual(serviceIdentity('asset-tracking-client', 'asset-tracking-client', {}), {
    serviceId: 'asset-tracking-client',
    serviceRepo: 'asset-tracking-client',
  })
})

test('identity default: repo-less component has a null owning repo', () => {
  assert.deepEqual(serviceIdentity('Payments', null, {}), { serviceId: 'Payments', serviceRepo: null })
})

test('override links a repo-less service to its owning (monorepo) repo', () => {
  const map = { 'device-data-access': { repo: 'device-data-service' } }
  assert.deepEqual(serviceIdentity('device-data-access', null, map), {
    serviceId: 'device-data-access',
    serviceRepo: 'device-data-service',
  })
})

test('an explicit null override wins over the scanned repo', () => {
  const map = { 'some-service': { repo: null } }
  assert.deepEqual(serviceIdentity('some-service', 'some-repo', map), { serviceId: 'some-service', serviceRepo: null })
})

test('serviceId is always the name verbatim; unmapped falls back to ownRepo', () => {
  assert.equal(serviceIdentity('X', 'r', { other: { repo: 'z' } }).serviceId, 'X')
  assert.equal(serviceIdentity('X', 'r', { other: { repo: 'z' } }).serviceRepo, 'r')
})

// Integration: the committed service-map.json overrides must resolve against the committed model —
// every override key is a real inventory service, and every override repo is a real repo folder.
test('committed service-map.json overrides resolve against the committed data', () => {
  const map = loadServiceMap()
  const data = JSON.parse(fs.readFileSync(path.join(AUDIT, 'fe-architecture.json'), 'utf8'))
  const names = new Set((data.inventory || []).map((e) => e.name))
  // known repos = drawn folders ∪ repoNames referenced by inventory (owning repo may be a real repo
  // that isn't cloned in a given run), matching the guard's resolution rule.
  const knownRepos = new Set([...(data.repos || []).map((r) => r.folder), ...(data.inventory || []).map((e) => e.repoName).filter(Boolean)])
  for (const [name, ov] of Object.entries(map)) {
    assert.ok(names.has(name), `service-map key "${name}" is not a known inventory service`)
    if (ov.repo != null) assert.ok(knownRepos.has(ov.repo), `service-map "${name}".repo "${ov.repo}" is not a known repo`)
  }
})
