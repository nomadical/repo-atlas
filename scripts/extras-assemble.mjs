import fs from 'node:fs'
import path from 'node:path'

import { AUDIT, ORG } from './_paths.mjs'
import { repos } from './repos.mjs'
const R = (f) => JSON.parse(fs.readFileSync(path.join(AUDIT,f),'utf8'))
const mid = R('scripts/extras-mid.json')
// guarded like the screens/backend reads below: a depcruise crash before its final write must
// degrade to the grep graphs, not kill the whole extras assembly
let dc = {}
try { dc = R('scripts/depcruise-out.json') } catch {}
const v1 = R('fe-architecture.json')
const v1graph = Object.fromEntries(v1.repos.map(r=>[r.folder, r.moduleGraph]))

// The org FE repos, auto-discovered (repos.mjs) — the same scope extras-gather scanned, guarded
// per-repo in case extras-mid.json predates a newly-cloned repo, and intersected with the
// assembled model so repos the map excludes (ignored/archived/PoCs) don't leave orphan
// ownership/testFootprint/purposes blocks in the extras.
const v1Folders = new Set(v1.repos.map((r) => r.folder))
const FE_REPOS = repos.feInOrg.filter((r) => mid[r] && v1Folders.has(r))

// ---- 1. Design-system component catalog ----
// HAND-AUDITED SNAPSHOT (July 2026), not derived — the catalog + cadence blocks below were read
// out of the ui repo by hand and are re-emitted verbatim every night. They're stamped with
// EXTRAS_AUDIT_AS_OF in the output so consumers can tell them from the measured fields;
// refresh the lists (and the date) when re-auditing.
// HAND-AUDITED, not derived: a library's real public surface (what the barrel actually exports vs.
// what merely exists under src/components) and its release habits need a human to read out. Fill
// these in for your design system and set EXTRAS_AUDIT_AS_OF; the detail panel hides the section
// while they're null. The asOf is stamped into the output so a consumer can always tell a dated
// hand-audit from a nightly-measured field.
const EXTRAS_AUDIT_AS_OF = null
const designSystemCatalog = null
const designSystemCadence = null

// ---- 3. ownership ----
const ownership = {}
for (const repo of FE_REPOS) ownership[repo] = mid[repo].codeowners
// extras-gather scans FE repos only, so a backend's CODEOWNERS has to be hand-carried here if you
// want it on the map. Key it by the repo's CANONICAL name — a stale pre-rename key matches no repo
// card and just sits as dead weight in the extras. e.g.:
//   ownership['my-backend'] = { present:true, file:'CODEOWNERS',
//     rules:[{ pattern:'*', owners:['@my-org/backend-team'] }],
//     owners:['@my-org/backend-team'], curated:true, asOf:EXTRAS_AUDIT_AS_OF }
const reposWithoutCodeowners = Object.entries(ownership).filter(([,v])=>!v.present).map(([k])=>k)

// ---- 4. test footprint — counted live per repo by extras-gather.mjs (file-walk) ----
const testFootprint = {}
for (const repo of FE_REPOS) {
  const t = mid[repo].tests
  testFootprint[repo] = {
    unitTestFiles: t.unitTotal, breakdown:{ dotTest:t.unitTest, dotSpec:t.unitSpec }, snapshots: t.snapshots ?? 0,
    stories: t.stories,
    playwrightSpecs: t.playwrightSpecs,
    coverage: t.coverage,
  }
}

// ---- 5. purposes ----
// The purpose is the repo's GitHub description — OWNER-OWNED, the same one-line "what it is" the
// governance page asks every owner to write. Falls back to the README/package.json first line
// (extras-gather) only when a repo has no description yet, so a terse or missing description is a
// visible curation gap for the owner to fix, not something patched over in a central file.
const descByRepo = Object.fromEntries((v1.repos || []).map((r) => [r.folder, r.inventory?.description || '']))
const purposes = {}
for (const repo of FE_REPOS) {
  const base = mid[repo].purpose
  const desc = descByRepo[repo]?.trim()
  purposes[repo] = desc ? { source: 'github description', text: desc, reliable: true } : { source: base.source, text: base.text, reliable: false }
}

// ---- 6. backend layer (scanned live by backend-scan.mjs from the cloned Java repos) ----
let backendTooling = { scanned: {}, missing: [] }
try { backendTooling = R('backend-tooling.json') } catch {}
// canonical GitHub name per repo basename (name-drift.json, from sync-names) — a checkout under a
// pre-rename folder (e.g. pharma-backend → intervention-backend) still resolves to the curated
// backend node, so a stale local folder and a canonical CI clone map to the same node.
let renameMap = {}
try {
  const nd = R('name-drift.json')
  renameMap = Object.fromEntries((nd.renames || []).map((r) => [r.from.split('/').pop().toLowerCase(), r.to.split('/').pop()]))
} catch {}
const canonicalOf = (name) => renameMap[String(name || '').toLowerCase()] || name
const backends = {
  scanned: Object.entries(backendTooling.scanned).map(([folder, s]) => ({
    folder, repoName: s.repoName || folder, canonicalName: canonicalOf(s.repoName || folder),
    defaultBranch: s.defaultBranch, lastCommit: s.lastCommit,
    stack: { language: s.java, framework: s.framework, build: s.buildTool },
    tooling: s.tooling, modules: s.modules,
    method: 'static (build.gradle/pom.xml + settings.gradle includes / pom <module>)',
  })),
  missing: backendTooling.missing.map((folder) => ({ folder, status: 'missing', note: 'not present in scan root (not cloned)' })),
}

// ---- 7. accurate module graphs ----
// depcruise (TS-resolved) where it ran; otherwise the grep graph from the main pipeline when
// that repo produced one; n/a for repos with no src/ graph at all.
const accurateModuleGraphs = { method:'depcruise where node_modules+typescript available; grep fallback otherwise', perRepo:{} }
for (const repo of FE_REPOS) {
  if (dc[repo] && dc[repo].method==='depcruise') {
    const entry = { method:'depcruise', tsResolved:true, modules:dc[repo].modules, resolvedDeps:dc[repo].resolvedDeps, crossFolderEdges:dc[repo].crossFolderEdges, edges:dc[repo].edges }
    if (repo==='knowledge-base') { entry.warning='depcruise resolved only 1 cross-folder edge (CRA tsconfig/jsconfig baseUrl aliases not picked up); grep graph (25 edges) is more representative.'; entry.grepCrossFolderEdges = v1graph[repo]?.crossFolderEdges ?? null }
    accurateModuleGraphs.perRepo[repo] = entry
  } else if (v1graph[repo]?.edges?.length) {
    const g = v1graph[repo]
    accurateModuleGraphs.perRepo[repo] = { method:'grep', tsResolved:false, reason:'no node_modules installed -> depcruise cannot resolve TS', crossFolderEdges:g?.crossFolderEdges??null, edges:g?.edges??[] }
  } else {
    accurateModuleGraphs.perRepo[repo] = { method:'n/a', reason:'no src/ graph (assets/test-only repo)' }
  }
}
// A note on how far the TS-resolved graphs agreed with the grep ones the last time you compared
// them — the honest way to say how much to trust the grep fallback. Set it when you check.
accurateModuleGraphs.validation = null

// ---- 8. per-screen views (router-parsed, with best-effort endpoint attribution) ----
// Reuse the repo-level swagger deep-links from fe-architecture.json so per-screen endpoints render
// the same clickable links the repo card already shows. Heuristic data — see scripts/screens-gather.mjs.
let screensRaw = { perRepo: {} }
try { screensRaw = R('scripts/screens-out.json') } catch {}
// Curated corrections to the heuristic screen data (screens-extra.json, keyed by repo folder):
//   { "<folder>": { drop:[component…], patch:{ "<component>": { name?, path?, roles?, endpoints?(replace),
//     addEndpoints?[…] } }, add:[ { name, component?, path?, roles?, endpoints? } ] } }
// Keys starting with "_" (e.g. _README) are ignored so the file can document itself.
let screensExtra = {}
try { screensExtra = R('screens-extra.json') } catch {}

// Apply a folder's curated overrides to its gathered screen list.
const applyScreenOverrides = (list, ov) => {
  if (!ov) return list
  const dropped = new Set(ov.drop || [])
  let out = list.filter((s) => !dropped.has(s.component) && !dropped.has(s.name))
  if (ov.patch) {
    out = out.map((s) => {
      const p = ov.patch[s.component] || ov.patch[s.name]
      if (!p) return s
      const endpoints = p.endpoints ? [...p.endpoints] : [...new Set([...(s.endpoints || []), ...(p.addEndpoints || [])])].sort()
      return { ...s, ...p, endpoints, curated: true }
    })
  }
  for (const a of ov.add || []) {
    out.push({ name: a.name, component: a.component || a.name, path: a.path || null, paths: a.path ? [a.path] : [], roles: a.roles || [], file: a.file || null, endpoints: (a.endpoints || []).slice().sort(), curated: true })
  }
  out.sort((x, y) => x.name.localeCompare(y.name))
  return out
}

const endpointLinksByRepo = Object.fromEntries(v1.repos.map((r) => [r.folder, r.endpointLinks || {}]))
const mappedRepos = new Set(v1.repos.map((r) => r.folder)) // only repos that exist on the assembled map
const screens = { method: 'router parse (*Router.tsx / <Route>) + import-graph endpoint tracing; folder fallback; screens-extra.json overrides', perRepo: {} }
// repos that have only curated screens (no gathered data) still get a block from screens-extra
const overrideFolders = Object.keys(screensExtra).filter((k) => !k.startsWith('_') && mappedRepos.has(k))
const folders = new Set([...Object.keys(screensRaw.perRepo || {}), ...overrideFolders])
for (const folder of folders) {
  if (!mappedRepos.has(folder)) continue
  const rep = screensRaw.perRepo?.[folder] || { method: 'curated', routerFiles: 0, screens: [] }
  const finalScreens = applyScreenOverrides(rep.screens || [], screensExtra[folder])
  if (!finalScreens.length) continue
  const links = endpointLinksByRepo[folder] || {}
  const used = {}
  for (const s of finalScreens) for (const e of s.endpoints) if (links[e]) used[e] = links[e]
  screens.perRepo[folder] = { method: rep.method, routerFiles: rep.routerFiles, endpointLinks: used, screens: finalScreens }
}

const out = {
  org:ORG,
  generatedAt:new Date().toISOString(),
  basedOn:'fe-architecture.json',
  // componentCatalog/releaseCadence are the dated hand-audit blocks above, not nightly-measured
  designSystem:{ asOf:EXTRAS_AUDIT_AS_OF, componentCatalog:designSystemCatalog, releaseCadence:designSystemCadence },
  screens,
  ownership:{ perRepo:ownership, reposWithoutCodeowners },
  testFootprint,
  purposes,
  backends,
  accurateModuleGraphs,
  // dated hand-audit observations (some are stale by design — e.g. "only pharma-backend is
  // present" predates the nightly backend auto-discovery); the asOf says when they were true
  // Dated hand-audit observations about the estate — things a scan can't see. Add your own.
  notes:{ asOf:EXTRAS_AUDIT_AS_OF, items:[] },
}
fs.writeFileSync(path.join(AUDIT,'fe-architecture-extras.json'), JSON.stringify(out,null,2))
console.log('wrote fe-architecture-extras.json')
console.log('reposWithoutCodeowners:', reposWithoutCodeowners.join(', '))
