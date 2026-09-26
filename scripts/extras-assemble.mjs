import fs from 'node:fs'
import path from 'node:path'

import { AUDIT, ORG } from './_paths.mjs'
import { repos } from './repos.mjs'

function readAuditJson(file) {
  return JSON.parse(fs.readFileSync(path.join(AUDIT, file), 'utf8'))
}

function readOptionalAuditJson(file, fallback) {
  try {
    return readAuditJson(file)
  } catch {
    return fallback
  }
}

const gathered = readAuditJson('scripts/extras-mid.json')
// Optional: a depcruise crash before its final write degrades to the grep graphs.
const depcruise = readOptionalAuditJson('scripts/depcruise-out.json', {})
const model = readAuditJson('fe-architecture.json')
const grepGraphByFolder = new Map(model.repos.map((repo) => [repo.folder, repo.moduleGraph]))
// Only repos on the assembled map, so excluded ones (ignored, archived, PoCs) leave no orphan blocks.
const mappedFolders = new Set(model.repos.map((repo) => repo.folder))

// The same scope extras-gather scanned. extras-mid.json can predate a newly cloned repo.
const FE_REPOS = repos.feInOrg.filter((folder) => gathered[folder] && mappedFolders.has(folder))

// ---- Design-system catalog and cadence (hand-audited) ------------------------------------------
// A library's real public surface and release habits need a human to read out. Fill these in and
// set EXTRAS_AUDIT_AS_OF; the detail panel hides the section while they're null. The asOf is
// emitted so consumers can tell a dated hand-audit from a measured field.
const EXTRAS_AUDIT_AS_OF = null
const designSystemCatalog = null
const designSystemCadence = null

// ---- Ownership -------------------------------------------------------------------------------
// extras-gather scans FE repos only, so a backend's CODEOWNERS has to be added here by hand, keyed
// by the repo's canonical name (a pre-rename key matches no card). For example:
//   ownership['my-backend'] = { present:true, file:'CODEOWNERS',
//     rules:[{ pattern:'*', owners:['@my-org/backend-team'] }],
//     owners:['@my-org/backend-team'], curated:true, asOf:EXTRAS_AUDIT_AS_OF }
const ownership = {}
for (const folder of FE_REPOS) ownership[folder] = gathered[folder].codeowners
const reposWithoutCodeowners = Object.entries(ownership)
  .filter(([, codeowners]) => !codeowners.present)
  .map(([folder]) => folder)

// ---- Test footprint (counted by extras-gather) -----------------------------------------------
function testFootprintOf(tests) {
  return {
    unitTestFiles: tests.unitTotal,
    breakdown: { dotTest: tests.unitTest, dotSpec: tests.unitSpec },
    snapshots: tests.snapshots ?? 0,
    stories: tests.stories,
    playwrightSpecs: tests.playwrightSpecs,
    coverage: tests.coverage,
  }
}

const testFootprint = {}
for (const folder of FE_REPOS) testFootprint[folder] = testFootprintOf(gathered[folder].tests)

// ---- Purposes --------------------------------------------------------------------------------
// The purpose is the repo's GitHub description, which the owner maintains. The README fallback is
// marked unreliable so a missing description stays a visible gap instead of being patched over.
const descriptionByFolder = new Map(
  (model.repos || []).map((repo) => [repo.folder, repo.inventory?.description || '']),
)

function purposeOf(folder) {
  const description = descriptionByFolder.get(folder)?.trim()
  if (description) return { source: 'github description', text: description, reliable: true }
  const fallback = gathered[folder].purpose
  return { source: fallback.source, text: fallback.text, reliable: false }
}

const purposes = {}
for (const folder of FE_REPOS) purposes[folder] = purposeOf(folder)

// ---- Backends (scanned by backend-scan.mjs) --------------------------------------------------
const backendTooling = readOptionalAuditJson('backend-tooling.json', { scanned: {}, missing: [] })

// Canonical GitHub name per repo basename, so a checkout under a pre-rename folder resolves to the
// same curated backend node as a canonical CI clone.
function loadRenamedBasenames() {
  try {
    const nameDrift = readAuditJson('name-drift.json')
    const basename = (slug) => slug.split('/').pop()
    return new Map(
      (nameDrift.renames || []).map((rename) => [basename(rename.from).toLowerCase(), basename(rename.to)]),
    )
  } catch {
    return new Map()
  }
}

const renamedBasenames = loadRenamedBasenames()
const canonicalOf = (name) => renamedBasenames.get(String(name || '').toLowerCase()) || name

function scannedBackend([folder, scan]) {
  return {
    folder,
    repoName: scan.repoName || folder,
    canonicalName: canonicalOf(scan.repoName || folder),
    defaultBranch: scan.defaultBranch,
    lastCommit: scan.lastCommit,
    stack: { language: scan.java, framework: scan.framework, build: scan.buildTool },
    tooling: scan.tooling,
    modules: scan.modules,
    method: 'static (build.gradle/pom.xml + settings.gradle includes / pom <module>)',
  }
}

const backends = {
  scanned: Object.entries(backendTooling.scanned).map(scannedBackend),
  missing: backendTooling.missing.map((folder) => ({
    folder,
    status: 'missing',
    note: 'not present in scan root (not cloned)',
  })),
}

// ---- Accurate module graphs ------------------------------------------------------------------
// depcruise (TS-resolved) where it ran, else the main pipeline's grep graph, else n/a.
// depcruise misses the CRA baseUrl aliases in this repo, so its grep graph is flagged as better.
const DEPCRUISE_UNDERCOUNTED_REPO = 'knowledge-base'

function depcruiseGraph(folder, result) {
  const graph = {
    method: 'depcruise',
    tsResolved: true,
    modules: result.modules,
    resolvedDeps: result.resolvedDeps,
    crossFolderEdges: result.crossFolderEdges,
    edges: result.edges,
  }
  if (folder === DEPCRUISE_UNDERCOUNTED_REPO) {
    graph.warning =
      'depcruise resolved only 1 cross-folder edge (CRA tsconfig/jsconfig baseUrl aliases not picked up); grep graph (25 edges) is more representative.'
    graph.grepCrossFolderEdges = grepGraphByFolder.get(folder)?.crossFolderEdges ?? null
  }
  return graph
}

function accurateModuleGraphOf(folder) {
  const result = depcruise[folder]
  if (result && result.method === 'depcruise') return depcruiseGraph(folder, result)
  const grepGraph = grepGraphByFolder.get(folder)
  if (grepGraph?.edges?.length) {
    return {
      method: 'grep',
      tsResolved: false,
      reason: 'no node_modules installed -> depcruise cannot resolve TS',
      crossFolderEdges: grepGraph?.crossFolderEdges ?? null,
      edges: grepGraph?.edges ?? [],
    }
  }
  return { method: 'n/a', reason: 'no src/ graph (assets/test-only repo)' }
}

const perRepoModuleGraphs = {}
for (const folder of FE_REPOS) perRepoModuleGraphs[folder] = accurateModuleGraphOf(folder)

const accurateModuleGraphs = {
  method: 'depcruise where node_modules+typescript available; grep fallback otherwise',
  perRepo: perRepoModuleGraphs,
  // How far the TS-resolved graphs agreed with the grep ones when last compared: the honest measure
  // of how far to trust the grep fallback. Set it when you check.
  validation: null,
}

// ---- Per-screen views (router-parsed, heuristic; see screens-gather.mjs) ---------------------
const gatheredScreens = readOptionalAuditJson('scripts/screens-out.json', { perRepo: {} })
// Curated corrections, keyed by repo folder:
//   { "<folder>": { drop:[component…], patch:{ "<component>": { name?, path?, roles?, endpoints?(replace),
//     addEndpoints?[…] } }, add:[ { name, component?, path?, roles?, endpoints? } ] } }
// Keys starting with "_" (e.g. _README) are ignored so the file can document itself.
const screenOverrides = readOptionalAuditJson('screens-extra.json', {})

function patchScreen(screen, patches) {
  const patch = patches[screen.component] || patches[screen.name]
  if (!patch) return screen
  const endpoints = patch.endpoints
    ? [...patch.endpoints]
    : [...new Set([...(screen.endpoints || []), ...(patch.addEndpoints || [])])].sort()
  return { ...screen, ...patch, endpoints, curated: true }
}

function addedScreen(addition) {
  return {
    name: addition.name,
    component: addition.component || addition.name,
    path: addition.path || null,
    paths: addition.path ? [addition.path] : [],
    roles: addition.roles || [],
    file: addition.file || null,
    endpoints: (addition.endpoints || []).slice().sort(),
    curated: true,
  }
}

function applyScreenOverrides(screens, overrides) {
  if (!overrides) return screens
  const dropped = new Set(overrides.drop || [])
  let result = screens.filter((screen) => !dropped.has(screen.component) && !dropped.has(screen.name))
  if (overrides.patch) result = result.map((screen) => patchScreen(screen, overrides.patch))
  for (const addition of overrides.add || []) result.push(addedScreen(addition))
  result.sort((a, b) => a.name.localeCompare(b.name))
  return result
}

// Reuses the repo-level swagger deep-links so screen endpoints get the same links as the repo card.
const endpointLinksByFolder = new Map(model.repos.map((repo) => [repo.folder, repo.endpointLinks || {}]))

function linksUsedBy(screens, links) {
  const used = {}
  for (const screen of screens) {
    for (const endpoint of screen.endpoints) {
      if (links[endpoint]) used[endpoint] = links[endpoint]
    }
  }
  return used
}

function collectScreens() {
  const perRepo = {}
  // Repos with curated screens only (nothing gathered) still get a block.
  const overrideFolders = Object.keys(screenOverrides).filter(
    (key) => !key.startsWith('_') && mappedFolders.has(key),
  )
  const folders = new Set([...Object.keys(gatheredScreens.perRepo || {}), ...overrideFolders])
  for (const folder of folders) {
    if (!mappedFolders.has(folder)) continue
    const report = gatheredScreens.perRepo?.[folder] || { method: 'curated', routerFiles: 0, screens: [] }
    const screens = applyScreenOverrides(report.screens || [], screenOverrides[folder])
    if (!screens.length) continue
    perRepo[folder] = {
      method: report.method,
      routerFiles: report.routerFiles,
      endpointLinks: linksUsedBy(screens, endpointLinksByFolder.get(folder) || {}),
      screens,
    }
  }
  return perRepo
}

const screens = {
  method:
    'router parse (*Router.tsx / <Route>) + import-graph endpoint tracing; folder fallback; screens-extra.json overrides',
  perRepo: collectScreens(),
}

// ---- Output ----------------------------------------------------------------------------------
const out = {
  org: ORG,
  generatedAt: new Date().toISOString(),
  basedOn: 'fe-architecture.json',
  designSystem: {
    asOf: EXTRAS_AUDIT_AS_OF,
    componentCatalog: designSystemCatalog,
    releaseCadence: designSystemCadence,
  },
  screens,
  ownership: { perRepo: ownership, reposWithoutCodeowners },
  testFootprint,
  purposes,
  backends,
  accurateModuleGraphs,
  // Dated hand-audit observations a scan can't see. Add your own.
  notes: { asOf: EXTRAS_AUDIT_AS_OF, items: [] },
}
fs.writeFileSync(path.join(AUDIT, 'fe-architecture-extras.json'), JSON.stringify(out, null, 2))
console.log('wrote fe-architecture-extras.json')
console.log('reposWithoutCodeowners:', reposWithoutCodeowners.join(', '))
