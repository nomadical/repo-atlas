// Safety net for automated regeneration: refuse to accept a freshly-generated
// fe-architecture.json if it regressed in a way that would silently corrupt the diagram.
// Exits non-zero so CI skips the commit and the last-good data stays published.
//
// Three classes of check:
//   1. Coverage   — core repos still present and the repo count hasn't collapsed (e.g. a
//                   clone failed in CI), which would silently drop nodes.
//   2. Integrity  — every edge endpoint (service link source, design-system consumer) resolves to a
//                   real node, so the graph can't reference a node that no longer exists.
//   3. Schema     — every inventory component's type/status is a known value, catching
//                   malformed/typo'd GitHub topics (e.g. `status-currnet`) at the source.
// Coverage and integrity failures are hard (exit 1). Schema deviations on the OPEN fields
// (owner, application — intentionally extensible) are warnings; the CLOSED enums (type,
// status) are hard failures.
//
// validate() is a pure function (data -> { errors, warnings }) so it can be unit-tested; the CLI
// section below reads the file, prints, and sets the exit code.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUDIT } from './_paths.mjs'
import { TOPIC_MAPS, SUBTYPE_PARENTS } from './inventory.mjs'

// Coverage tripwires, from config.json `guard`. These are what stop a half-failed nightly run from
// committing a map with half the estate missing, so set them once the map looks right: take today's
// real counts and back off ~20%. Left unset they're inert — a fresh fork isn't blocked by numbers it
// hasn't earned yet, but it also isn't protected, so don't leave them unset forever.
//
//   coreRepos    — folders that must always be present. Cloned, not topic-derived, so they survive
//                  a token losing topic scope: pick the handful whose absence means a broken clone.
//   minRepos     — floor on scanned repos, catching a clone step that failed wholesale.
//   minInventory — floor on the whole Component Inventory. Repos join it via GitHub topics, so a
//                  token losing topic scope strips dozens of components while every coreRepo
//                  survives — minRepos alone can't see that collapse.
const guardConfig = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(AUDIT, 'config.json'), 'utf8')).guard || {} } catch { return {} }
})()
export const CORE = Array.isArray(guardConfig.coreRepos) ? guardConfig.coreRepos : []
export const MIN_REPOS = Number.isFinite(guardConfig.minRepos) ? guardConfig.minRepos : 0
export const MIN_INVENTORY = Number.isFinite(guardConfig.minInventory) ? guardConfig.minInventory : 0

// opts.maxAgeHours: when set, data.generatedAt must be within that window. Only the nightly
// regenerate sets it (via GUARD_MAX_AGE_HOURS) — its pipeline step tolerates individual script
// failures, so a failed gather/assemble can leave the checkout's stale fe-architecture.json
// sitting next to refreshed sibling files; this stops that mixed-generation commit. A plain
// `npm run guard` on days-old committed data stays valid, so no default.
export function validate(data, extras = null, opts = {}) {
  const errors = []
  const warnings = []

  if (opts.maxAgeHours > 0) {
    const age = Date.now() - new Date(data.generatedAt || 0).getTime()
    if (!data.generatedAt || Number.isNaN(age)) errors.push('generatedAt is missing/unparsable (freshness check requested)')
    else if (age > opts.maxAgeHours * 3600000) {
      errors.push(`generatedAt is ${Math.round(age / 3600000)}h old (max ${opts.maxAgeHours}h) — the pipeline did not regenerate fe-architecture.json this run`)
    }
  }

  // ---- 0. structural shape (mirrors schema/fe-architecture.schema.json required fields; the
  // ajv schema test enforces the full contract on every CI run, this guards the nightly path) --
  if (!Array.isArray(data.repos)) errors.push('repos is not an array')
  if (!Array.isArray(data.inventory)) errors.push('inventory is not an array')
  if ((data.repos || []).some((r) => typeof r.folder !== 'string' || !r.folder)) errors.push('a repo is missing its folder')
  if ((data.inventory || []).some((c) => typeof c.name !== 'string' || !c.name)) errors.push('an inventory component is missing its name')

  // ---- 1. coverage ------------------------------------------------------------------
  const repoFolders = new Set((data.repos || []).map((r) => r.folder))
  const count = data.repos?.length || 0
  const missingCore = CORE.filter((f) => !repoFolders.has(f))
  if (missingCore.length) errors.push(`missing core repos: ${missingCore.join(', ')}`)
  if (count < MIN_REPOS) errors.push(`only ${count} repos (min ${MIN_REPOS})`)
  const invCount = data.inventory?.length || 0
  if (invCount < MIN_INVENTORY) errors.push(`only ${invCount} inventory components (min ${MIN_INVENTORY}) — topics stripped / github-inventory failed?`)
  // integrations.csv always carries curated rows and assemble derives more from the backend scan,
  // so an empty list means an input was lost (CSV unreadable AND backend-tooling empty/stale).
  if (!(data.integrations || []).length) errors.push('integrations is empty — integrations.csv unread or the service-link derivation lost its inputs')

  // ---- 2. referential integrity -----------------------------------------------------
  // The node universe the graph can draw: repos (by folder) plus inventory components (by name,
  // which covers non-repo third-party services). External edge targets (Kafka, SaaS backends)
  // are intentionally not nodes, so only edge SOURCES are integrity-checked.
  const inventoryNames = new Set((data.inventory || []).map((i) => i.name))
  // Backend nodes (curated overlay) are drawable nodes too, addressable by id / repo / label /
  // inventory alias — integrations.csv rows reference backends by these names (see graph.js beIdByKey).
  const backendKeys = new Set(
    (data.backendTopology?.backends || []).flatMap((b) => [b.id, b.repo, b.label, b.invAlias].filter(Boolean)),
  )
  // 'Kafka' is the shared event-bus pseudo-node — a valid endpoint on either side of a link.
  const isNode = (id) => id === 'Kafka' || repoFolders.has(id) || inventoryNames.has(id) || backendKeys.has(id)
  for (const link of data.integrations || []) {
    if (!isNode(link.source)) errors.push(`service link source "${link.source}" is not a known node`)
  }
  for (const c of data.uiConsumers || []) {
    if (!repoFolders.has(c.repo)) errors.push(`design-system consumer "${c.repo}" is not a present repo`)
  }
  // Curated topology extras (backend-extra.json): dangling references degrade to a missing edge/node
  // on the map (both endpoints must exist to draw), so warn rather than block.
  for (const e of data.backendTopology?.serviceEdges || []) {
    for (const end of [e.source, e.target]) {
      if (end && !isNode(end)) warnings.push(`serviceEdges: "${end}" is not a known node (edge won't draw)`)
    }
  }
  for (const c of data.backendTopology?.contentRepos || []) {
    if (c.parent && !isNode(c.parent)) warnings.push(`contentRepos: parent "${c.parent}" is not a known node (card won't draw)`)
  }
  // Service identity (backlog #16): a non-null serviceRepo names the repo that OWNS a service (e.g. a
  // monorepo linking a repo-less service). It must resolve to a KNOWN repo — a drawn folder OR a repo
  // referenced by an inventory component's repoName (the owning repo can be a real GitHub repo that
  // isn't cloned in this run, so it need not be a drawn node). A truly dangling reference is an error.
  // Optional pre-migration: entries without serviceRepo are skipped, so older data still validates.
  const knownRepos = new Set([...repoFolders, ...(data.inventory || []).map((e) => e.repoName).filter(Boolean)])
  for (const e of [...(data.repos || []), ...(data.inventory || [])]) {
    if (e.serviceRepo != null && !knownRepos.has(e.serviceRepo)) {
      errors.push(`serviceRepo "${e.serviceRepo}" (of service "${e.serviceId || e.name || e.folder}") is not a known repo`)
    }
  }

  // ---- 2b. backend-trace completeness (soft) ----------------------------------------
  // The per-client drill-down resolves each endpoint to a backend by host; an FE apiUrl host with no
  // backend node makes that trace dead-end. Warn so the backend is modeled in backend-extra.json.
  const normHost = (h) =>
    String(h || '')
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/\.(dev|test|pre|prod|demo|poc|nonprod|sandbox|e2e)(?=\.)/g, '.{env}')
      .toLowerCase()
  const backendHosts = new Set((data.backendTopology?.backends || []).filter((b) => b.host).map((b) => normHost(b.host)))
  if (backendHosts.size) {
    for (const r of data.repos || []) {
      if (r.apiUrl && !backendHosts.has(normHost(r.apiUrl))) {
        warnings.push(`"${r.folder}": apiUrl host "${r.apiUrl}" has no backend node (FE→backend trace dead-ends; add it to backend-extra.json)`)
      }
    }
  }

  // ---- 3. topic-schema conformance --------------------------------------------------
  const KNOWN_TYPE = new Set(Object.keys(TOPIC_MAPS.type))
  const KNOWN_STATUS = new Set(Object.keys(TOPIC_MAPS.status))
  const KNOWN_OWNER = new Set(Object.keys(TOPIC_MAPS.owner))
  const halfCurated = [] // repo-backed components on the map (have a type) but missing owner/status/description
  const KNOWN_SUBTYPE = new Set(Object.keys(TOPIC_MAPS.subtype || {}))
  for (const c of data.inventory || []) {
    if (c.type && !KNOWN_TYPE.has(c.type)) errors.push(`"${c.name}": unknown type "${c.type}" (bad type-* topic?)`)
    // subtype is a closed enum AND pair-checked against its parent type (SUBTYPE_PARENTS)
    if (c.subtype) {
      if (!KNOWN_SUBTYPE.has(c.subtype)) errors.push(`"${c.name}": unknown subtype "${c.subtype}" (bad subtype-* topic?)`)
      else if (c.type && !(SUBTYPE_PARENTS[c.subtype] || []).includes(c.type)) {
        errors.push(`"${c.name}": subtype "${c.subtype}" is not valid for type "${c.type}" (allowed on: ${(SUBTYPE_PARENTS[c.subtype] || []).join(', ')})`)
      }
    }
    if (c.status && !KNOWN_STATUS.has(c.status)) errors.push(`"${c.name}": unknown status "${c.status}" (bad status-* topic?)`)
    // owner/application are open sets — flag-but-don't-block so new teams/apps can be added freely.
    // With no `owners` map in config.json the vocabulary is undeclared, so there's nothing to be
    // off-schema against and the check stays quiet rather than warning on every component.
    if (KNOWN_OWNER.size && c.owner && !KNOWN_OWNER.has(c.owner)) warnings.push(`"${c.name}": owner "${c.owner}" not in the documented schema`)
    if (c.repoName && c.type) {
      const missing = ['owner', 'status', 'description'].filter((f) => !c[f])
      if (missing.length) halfCurated.push({ name: c.name, missing })
    }
  }
  // Half-curated components are warn-only (they render, just with gaps). Summarize into ONE line —
  // the per-component detail lives in validation.incompleteCuration (the map's health pill) and the
  // weekly curation-report issue, so 70+ individual guard lines would just bury the real warnings.
  if (halfCurated.length) {
    const byField = { owner: 0, status: 0, description: 0 }
    for (const h of halfCurated) for (const f of h.missing) byField[f]++
    const breakdown = Object.entries(byField)
      .filter(([, n]) => n)
      .map(([f, n]) => `${n} missing ${f}`)
      .join(', ')
    warnings.push(`${halfCurated.length} components half-curated (${breakdown}) — see the weekly curation report / validation.incompleteCuration`)
  }

  // ---- 4. screens (soft; only when extras is provided) ------------------------------
  // Per-screen data is heuristic, so never block on it — just surface a parser regression. The
  // signal is a COLLAPSE in coverage (router parser broke org-wide), not the handful of clients
  // that legitimately have no routes (docs sites, mobile shells).
  if (extras?.screens?.perRepo) {
    const perRepo = extras.screens.perRepo
    for (const folder of Object.keys(perRepo)) {
      if (!repoFolders.has(folder)) warnings.push(`screens: "${folder}" is not a present repo`)
    }
    const clients = (data.repos || []).filter((r) => r.kind === 'client').map((r) => r.folder)
    const withScreens = clients.filter((f) => perRepo[f]?.screens?.length)
    if (clients.length && withScreens.length < Math.ceil(clients.length / 2)) {
      warnings.push(`screens: only ${withScreens.length}/${clients.length} client repos produced screens (router parser regression?)`)
    }
  }

  return { errors, warnings, count }
}

// ---- CLI ------------------------------------------------------------------------------
// Run only when invoked directly (not when imported by a test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = JSON.parse(fs.readFileSync(path.join(AUDIT, 'fe-architecture.json'), 'utf8'))
  let extras = null
  try { extras = JSON.parse(fs.readFileSync(path.join(AUDIT, 'fe-architecture-extras.json'), 'utf8')) } catch {}
  const maxAgeHours = Number(process.env.GUARD_MAX_AGE_HOURS)
  const { errors, warnings, count } = validate(data, extras, maxAgeHours > 0 ? { maxAgeHours } : {})
  for (const w of warnings) console.warn(`⚠ ${w}`)
  if (errors.length) {
    console.error(`✗ data guard FAILED — not committing. ${count} repos.`)
    for (const e of errors) console.error(`  • ${e}`)
    process.exit(1)
  }
  console.log(`✓ data guard passed — ${count} repos, all ${CORE.length} core present, edges + topic schema valid` +
    (warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''))
}
