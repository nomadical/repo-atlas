// Service <-> repo identity resolver.
//
// A service's canonical id is its Component Inventory name. By default it is owned by the repo it is
// scanned from (or by no repo, e.g. third-party services). service-map.json holds only overrides to
// that default, chiefly repo-less services that ship from a monorepo (device-data-*).
import fs from 'node:fs'
import path from 'node:path'
import { AUDIT } from './_paths.mjs'

export function loadServiceMap(file = path.join(AUDIT, 'service-map.json')) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))?.services || {}
  } catch {
    return {}
  }
}

//   name    - the inventory name (the canonical service id)
//   ownRepo - the repo folder it is scanned from, or null for a repo-less inventory entry
//   map     - the `services` object from service-map.json
// An override with an explicit `repo: null` wins over ownRepo.
export function serviceIdentity(name, ownRepo = null, map = {}) {
  const override = map[name]
  const hasRepoOverride = override && Object.prototype.hasOwnProperty.call(override, 'repo')
  const serviceRepo = hasRepoOverride ? override.repo : ownRepo
  return { serviceId: name, serviceRepo: serviceRepo ?? null }
}
