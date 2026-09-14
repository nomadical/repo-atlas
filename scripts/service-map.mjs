// Service <-> repo identity resolver (backlog #16, Phase 1).
//
// Component identity is moving from the repo FOLDER to the SERVICE. A service's canonical id is its
// Component-Inventory name; by default the service is owned by the repo it is scanned from (or has no
// repo at all, e.g. third-party services). service-map.json holds only the OVERRIDES to that default —
// chiefly repo-less services that actually ship from a monorepo (device-data-*), linked back to their
// owning repo so they can later (Phase 2) draw as first-class service nodes sharing that repo.
//
// Phase 1 is purely additive: serviceIdentity() attaches serviceId/serviceRepo metadata to the
// generated data; the viz still keys by folder, so with the identity default the rendered map is
// unchanged and only the mapped (device-data) services gain an explicit repo link.
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

// Resolve a component's service identity.
//   name    — its inventory name (the canonical service id)
//   ownRepo — the repo folder it is scanned from, or null for a repo-less inventory entry
//   map     — the `services` object from service-map.json (default = identity)
// Returns { serviceId, serviceRepo }. serviceRepo is the owning repo folder, or null.
export function serviceIdentity(name, ownRepo = null, map = {}) {
  const ov = map[name]
  const serviceRepo = ov && Object.prototype.hasOwnProperty.call(ov, 'repo') ? ov.repo : (ownRepo ?? null)
  return { serviceId: name, serviceRepo: serviceRepo ?? null }
}
