// Tests for the service <-> repo identity resolver. Run with `node --test`.
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
  assert.deepEqual(serviceIdentity('some-service', 'some-repo', map), {
    serviceId: 'some-service',
    serviceRepo: null,
  })
})

test('serviceId is always the name verbatim; unmapped falls back to ownRepo', () => {
  const unrelatedMap = { other: { repo: 'z' } }
  assert.equal(serviceIdentity('X', 'r', unrelatedMap).serviceId, 'X')
  assert.equal(serviceIdentity('X', 'r', unrelatedMap).serviceRepo, 'r')
})

// Every override key must be a real inventory service and every override repo a real repo folder.
test('committed service-map.json overrides resolve against the committed data', () => {
  const serviceMap = loadServiceMap()
  const data = JSON.parse(fs.readFileSync(path.join(AUDIT, 'fe-architecture.json'), 'utf8'))
  const inventory = data.inventory || []
  const inventoryNames = new Set(inventory.map((entry) => entry.name))
  // An owning repo may be real but not cloned in a given run, so inventory repoNames count too.
  const knownRepos = new Set([
    ...(data.repos || []).map((repo) => repo.folder),
    ...inventory.map((entry) => entry.repoName).filter(Boolean),
  ])
  for (const [name, override] of Object.entries(serviceMap)) {
    assert.ok(inventoryNames.has(name), `service-map key "${name}" is not a known inventory service`)
    if (override.repo == null) continue
    assert.ok(
      knownRepos.has(override.repo),
      `service-map "${name}".repo "${override.repo}" is not a known repo`,
    )
  }
})
