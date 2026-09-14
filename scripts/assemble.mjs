import fs from 'node:fs'
import path from 'node:path'

import { ROOT, AUDIT, ORG, inOrg } from './_paths.mjs'
import { uncloned, OUTSIDE, remoteOf } from './repos.mjs'
import { loadInventory, loadIntegrations, loadThirdPartyMeta } from './inventory.mjs'
import { loadServiceMap, serviceIdentity } from './service-map.mjs'

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
// Curated per-repo knowledge (FE→BE notes, Azure name maps, …) — data, not code (repo-extra.json).
const repoExtra = readJson(path.join(AUDIT, 'repo-extra.json')) || {}
// App config (config.json) — same file the viz reads. The pipeline only needs a couple of fields
// (design-system package names); everything else is viz-side.
const appConfig = readJson(path.join(AUDIT, 'config.json')) || {}

// Component Inventory (live from GitHub topics + inventory-extra.json, via inventory.mjs) —
// attach each repo's inventory record by GitHub repo basename, with aliases for components
// whose repo column is empty / differs.
const { inventory, byRepo, byName, ignored } = loadInventory()
// Service identity (backlog #16, Phase 1 — additive). serviceId = the inventory name; serviceRepo =
// the owning repo folder, or null for a repo-less service. Default is identity; service-map.json
// overrides only the repo link (e.g. repo-less device-data-* services shipped from a monorepo).
const serviceMap = loadServiceMap()
// inventory serviceRepo is override-only (null unless the map links a repo-less service to an owning
// repo) — the repo-backed link is carried by repos[].serviceRepo below, avoiding a repoName≠folder edge.
for (const e of inventory) Object.assign(e, serviceIdentity(e.name, null, serviceMap))
// merge third-party metadata onto the matching inventory entries
const tpMeta = loadThirdPartyMeta()
for (const e of inventory) { const m = tpMeta[e.name.toLowerCase()]; if (m) e.meta = m }
const integrations = loadIntegrations()

// ---- code-derived Kafka integrations (backend-scan.mjs messaging channels) -----------------
// Producers and consumers are matched by TOPIC, so service-to-service links come from the code
// instead of hand-maintained CSV rows. Attribution: the declaring module when it is itself an
// inventory component (the device-data-* modules ship as separate services), else the repo's
// inventory name, else the repo name (which backend nodes resolve by). Matched pairs become
// direct edges labeled with the topic; producer-only topics point at the shared Kafka bus and
// consumer-only topics come from it. A curated integrations.csv row for the same pair is kept
// (its channel/note win) but flips to verified — the code confirms it.
let beTooling = null
try { beTooling = JSON.parse(fs.readFileSync(path.join(AUDIT, 'backend-tooling.json'), 'utf8')) } catch {}
if (beTooling?.scanned) {
  const producers = {}, consumers = {} // topic -> Set(component)
  for (const [folder, s] of Object.entries(beTooling.scanned)) {
    const repoComponent = (byRepo[s.repoName || folder] || [])[0]?.name || s.repoName || folder
    for (const ch of s.messaging || []) {
      const component = (ch.module && byName[ch.module.toLowerCase()]?.name) || repoComponent
      const map = ch.direction === 'outgoing' ? producers : consumers
      ;(map[ch.topic] = map[ch.topic] || new Set()).add(component)
    }
  }
  const pairs = {} // "source\u0000target" -> Set(topics)
  const addPair = (s, t, topic) => { if (s !== t) (pairs[s + '\u0000' + t] = pairs[s + '\u0000' + t] || new Set()).add(topic) }
  for (const topic of new Set([...Object.keys(producers), ...Object.keys(consumers)])) {
    const ps = [...(producers[topic] || [])], cs = [...(consumers[topic] || [])]
    if (ps.length && cs.length) { for (const p of ps) for (const c of cs) addPair(p, c, topic) }
    else if (ps.length) for (const p of ps) addPair(p, 'Kafka', topic)
    else for (const c of cs) addPair('Kafka', c, topic)
  }
  // The edge label shows the first few topics; the COMPLETE list is preserved in `channelFull`
  // whenever it would be truncated, so a busy pair never silently hides a real topic (e.g.
  // one gateway consuming another service's topic behind a bare "+1"). The renderer shows it on hover.
  const SHOWN = 3
  const label = (ts) => { const a = [...ts].sort(); return a.slice(0, SHOWN).join(', ') + (a.length > SHOWN ? ` +${a.length - SHOWN}` : '') }
  const full = (ts) => [...ts].sort().join(', ')
  // Dedup key is (source, target) over KAFKA rows only — mirroring the REST block's
  // protocol-aware pkey below: a pair can legitimately talk both REST and Kafka, so Kafka
  // evidence must only ever confirm a curated Kafka row, never flip a REST row for the same
  // pair (which would also swallow the derived Kafka edge). First row wins on duplicates.
  const byPair = {}
  for (const r of integrations) {
    if ((r.protocol || '').toLowerCase() !== 'kafka') continue
    const k = `${r.source}\u0000${r.target}`.toLowerCase()
    if (!(k in byPair)) byPair[k] = r
  }
  let added = 0, confirmed = 0
  for (const [key, ts] of Object.entries(pairs)) {
    const [s, t] = key.split('\u0000')
    const cur = byPair[key.toLowerCase()]
    const ch = label(ts), cf = full(ts)
    if (cur) {
      cur.verified = true
      cur.via = 'code'
      cur.curated = true // provenance survives the flip: the Admin panel keeps curated rows in integrations.csv on save
      if (!cur.channel) { cur.channel = ch; if (cf !== ch) cur.channelFull = cf }
      confirmed++
    } else {
      integrations.push({ source: s, target: t, protocol: 'Kafka', channel: ch, ...(cf !== ch ? { channelFull: cf } : {}), note: 'Derived from mp.messaging topics (backend-scan)', verified: true, via: 'code' })
      added++
    }
  }
  console.log(`kafka integrations derived from code: ${added} added, ${confirmed} CSV rows confirmed`)
}
// Curated backend topology (hosts, kind, FE→BE wiring, backend→external SaaS) that can't be
// auto-derived from the clone/scan/inventory pipeline. graph.js merges this with the live
// backend scan (extras.backends.scanned) so a newly-cloned backend still appears. Optional:
// a missing/garbled file degrades to an empty overlay (backends fall back to scan-only).
let backendTopology = { backends: [], feBe: {}, backendExternals: {}, assetConsumers: [], serviceEdges: [], contentRepos: [], restHostAliases: {} }
try {
  const be = JSON.parse(fs.readFileSync(path.join(AUDIT, 'backend-extra.json'), 'utf8'))
  backendTopology = {
    backends: be.backends || [], feBe: be.feBe || {}, backendExternals: be.backendExternals || {},
    assetConsumers: be.assetConsumers || [], serviceEdges: be.serviceEdges || [], contentRepos: be.contentRepos || [],
    restHostAliases: be.restHostAliases || {},
    ...(be.assetsSource ? { assetsSource: be.assetsSource } : {}),
  }
} catch (e) { console.warn('backend-extra.json not loaded — backend overlay empty:', e.message) }

// ---- code-derived REST integrations (backend-scan.mjs outbound URL config) -----------------
// These backends don't use a typed REST client — they configure an outbound base URL and call it
// via HttpClient/Retrofit, so the URL HOST identifies the target service and the path is only a
// label. We resolve each scanned backend's restConsumes host to a component (inventory name,
// backend-node alias, or a known third party by registered domain) and emit a REST edge, mirroring
// the Kafka derivation: via:'code'/verified:true, deduped against integrations.csv (a curated row
// for the same pair keeps its channel/note and flips to verified). Host-based matching is
// deliberate — consumers rarely restate the provider's full server path — so provider @Path roots
// only REFINE the channel label, never gate an edge. Hosts that pass the scanner's infra filter but
// resolve to no component are reported for curation (backend-extra.json / inventory alias /
// third-party-meta.csv), never silently dropped.
if (beTooling?.scanned) {
  // Collapse every alias of a backend node (id/repo/label/invAlias) to ONE canonical token so a
  // derived row (keyed by inventory/repo name) dedups against a curated CSV row (often keyed by the
  // backend LABEL) — e.g. orders-service ≡ be-orders, or a service renamed but still pinned under the old name.
  const beCanon = {}
  for (const b of backendTopology.backends || []) {
    const canonName = b.invAlias || b.repo || b.label || b.id
    for (const a of [b.id, b.repo, b.label, b.invAlias].filter(Boolean)) beCanon[a.toLowerCase()] = canonName
  }
  const canon = (name) => (name == null ? name : beCanon[String(name).toLowerCase()] || name)
  const normHost = (h) => String(h || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    .replace(/:\d+$/, '').replace(/\.(dev|test|pre|prod|demo|poc|nonprod|sandbox|e2e)(?=\.)/g, '.{env}').toLowerCase()
  const regDomain = (h) => { const p = String(h).split('.'); return p.length > 1 ? p.slice(-2).join('.') : h }

  // token -> canonical component, from every resolvable identity already in the data. NB: backend
  // host FIELDS are indexed only as the full host (api.example.com), never the bare head 'api',
  // which would wrongly swallow unrelated externals (api.tive.com, api.dsv.com, …).
  const nodeIndex = {}
  const put = (tok, name) => { if (tok && !(tok in nodeIndex)) nodeIndex[String(tok).toLowerCase()] = name }
  for (const e of inventory) put(e.name, canon(e.name))
  for (const b of backendTopology.backends || []) {
    const c = canon(b.id)
    for (const a of [b.id, b.repo, b.label, b.invAlias].filter(Boolean)) put(a, c)
    if (b.host) put(normHost(b.host), c)
  }
  // Known third parties (third-party-meta.csv): resolve by the registered domain of their homepage
  // (openweathermap.org → openweather) and by any curated API host(s) whose domain differs from the
  // homepage (googleapis.com, hana.ondemand.com, maps.mail.ru). Resolve to the real inventory name
  // (proper case) when the service is a drawable node, so the edge renders.
  for (const [lname, m] of Object.entries(tpMeta)) {
    const name = byName[lname]?.name || lname
    if (m.url) put(regDomain(normHost(m.url)), name)
    for (const h of m.hosts || []) { const nh = normHost(h); put(nh, name); put(regDomain(nh), name) }
  }
  // Curated internal aliases (backend-extra.json restHostAliases): a URL token (gateway path segment
  // like skycore/<service>, or a host head) that resolves to a component under a different name —
  // e.g. co2-service → skycore-co2-backend, sensor-data-ingestion → device-data-ingestion.
  // Assigned directly (NOT via first-wins put()): a curated alias exists precisely to redirect a
  // token, so it must beat any derived entry already indexed under the same name — put() would
  // silently drop it, inverting the curated-over-derived precedence rule.
  for (const [token, target] of Object.entries(backendTopology.restHostAliases || {})) {
    if (token.startsWith('_')) continue // skip the _comment key
    nodeIndex[token.toLowerCase()] = canon(byName[target.toLowerCase()]?.name || target)
  }

  // Provider @Path roots per resolved component — used only to confirm/refine a matched edge's label.
  const rootsByComponent = {}
  for (const [folder, s] of Object.entries(beTooling.scanned)) {
    const repoComponent = (byRepo[s.repoName || folder] || [])[0]?.name || s.repoName || folder
    for (const p of s.restProvides || []) {
      const comp = canon((p.module && byName[p.module.toLowerCase()]?.name) || repoComponent)
      ;(rootsByComponent[comp] = rootsByComponent[comp] || new Set())
      for (const r of p.roots || []) rootsByComponent[comp].add(r)
    }
  }

  // Try candidate tokens drawn from the URL, most specific first. Path segments come BEFORE the host
  // head because a gateway host (skycore/<service>) names the real service in the path — the head
  // ('skycore') is only a fallback when no segment resolves. Direct-service URLs carry no useful
  // path, so they fall through to the host. The registered domain + SLD are last (for third parties).
  const resolveTarget = (c) => {
    const segs = (c.path || '').split('/').filter(Boolean)
    const rd = regDomain(c.host)
    for (const t of [segs[0], segs[1], c.host, c.hostHead, rd, rd.split('.')[0]].filter(Boolean)) {
      const hit = nodeIndex[t.toLowerCase()]
      if (hit) return hit
    }
    return null
  }

  // Keyed by canonical (source, target, PROTOCOL): a pair can legitimately talk both REST and Kafka,
  // so a derived REST edge must never confirm/swallow the Kafka row for the same pair (or vice versa).
  const pkey = (sc, tg, pr) => `${canon(sc)}\u0000${canon(tg)}\u0000${(pr || 'REST').toLowerCase()}`
  const byPairR = Object.fromEntries(integrations.map((r) => [pkey(r.source, r.target, r.protocol), r]))
  let addedR = 0, confirmedR = 0
  const unresolved = new Map() // host -> Set(source)
  for (const [folder, s] of Object.entries(beTooling.scanned)) {
    const repoComponent = (byRepo[s.repoName || folder] || [])[0]?.name || s.repoName || folder
    for (const c of s.restConsumes || []) {
      const source = canon((c.module && byName[c.module.toLowerCase()]?.name) || repoComponent)
      const target = resolveTarget(c)
      if (!target) {
        if (!unresolved.has(c.host)) unresolved.set(c.host, new Set())
        unresolved.get(c.host).add(source)
        continue
      }
      if (target === source) continue // self-reference (e.g. ip.be.application.url → own host)
      const seg0 = '/' + (((c.path || '').split('/').filter(Boolean))[0] || '')
      const roots = rootsByComponent[target]
      const channel = roots && roots.has(seg0)
        ? seg0 // path prefix matches a real @Path resource root on the target → confirmed label
        : (c.path && c.path !== '/' ? c.path : c.propKey.replace(/[._-]?(base-?url|url|endpoint)$/i, ''))
      const key = pkey(source, target, 'REST')
      const cur = byPairR[key]
      if (cur) {
        cur.verified = true
        cur.via = 'code'
        cur.curated = true // provenance survives the flip (see the Kafka block)
        if (!cur.channel) cur.channel = channel
        confirmedR++
      } else {
        const row = { source, target, protocol: 'REST', channel, note: 'Derived from outbound URL config (backend-scan)', verified: true, via: 'code' }
        integrations.push(row)
        byPairR[key] = row
        addedR++
      }
    }
  }
  // A backend can appear under several alias names (a pre-rename name alongside its current one), so the
  // CSV can carry two rows for what is really one edge. Collapse integrations to one row per
  // canonical (source, target, protocol), preferring the verified / code-derived row and merging
  // the loser's channel/note when the winner lacks them.
  const rank = (r) => (r.via === 'code' ? 2 : 0) + (r.verified ? 1 : 0)
  const best = new Map()
  for (const r of integrations) {
    const k = pkey(r.source, r.target, r.protocol)
    const prev = best.get(k)
    if (!prev) { best.set(k, r); continue }
    const [win, lose] = rank(r) > rank(prev) ? [r, prev] : [prev, r]
    if (!win.channel && lose.channel) win.channel = lose.channel
    if (!win.note && lose.note) win.note = lose.note
    if (lose.curated) win.curated = true // curated provenance survives an alias-duplicate merge
    best.set(k, win)
  }
  const removed = integrations.length - best.size
  integrations.length = 0
  integrations.push(...best.values())

  const unresolvedList = [...unresolved.keys()].sort()
  console.log(`rest integrations derived from code: ${addedR} added, ${confirmedR} CSV rows confirmed, ${removed} alias-duplicate rows merged, ${unresolvedList.length} unresolved hosts${unresolvedList.length ? ' (' + unresolvedList.join(', ') + ')' : ''}`)
}

const INV_ALIAS = {}
const renamedBasename = {} // local folder -> repo basename after a GitHub rename (filled from name-drift.json below)
const inventoryFor = (folder) => {
  if (INV_ALIAS[folder]) return byName[INV_ALIAS[folder].toLowerCase()] || null
  return (byRepo[folder] || [])[0] || (renamedBasename[folder] ? (byRepo[renamedBasename[folder]] || [])[0] : null) || null
}
const S = (f) => JSON.parse(fs.readFileSync(path.join(AUDIT,'scripts',f),'utf8'))
const gather = S('gather-out.json')
const wf = S('workflows-out.json')
const mg = S('modulegraph-out.json')

// Remotes come from each clone's own `remote.origin.url` (repos.mjs), so links and org
// membership can't drift from reality — no curated URL map to maintain.
//
// name-drift.json (sync-names.mjs): GitHub repos renamed/deleted since the clone was made.
// Renames are applied at runtime so links stay canonical even before the local folder/CSV
// catch up; both cases are surfaced in pipeline health.
let nameDrift = null
try { nameDrift = JSON.parse(fs.readFileSync(path.join(AUDIT, 'name-drift.json'), 'utf8')) } catch {}
const renamedUrl = Object.fromEntries((nameDrift?.renames || []).map((r) => [r.from.toLowerCase(), r.url]))
const remotes = {}
for (const g of gather) {
  let url = remoteOf(g.folder)
  const m = String(url || '').match(/github\.com\/([^/]+\/[^/.]+)/i)
  if (m && renamedUrl[m[1].toLowerCase()]) {
    url = renamedUrl[m[1].toLowerCase()] + '.git'
    renamedBasename[g.folder] = url.split('/').pop().replace(/\.git$/, '') // keep inventory matching working
  }
  remotes[g.folder] = url
}

// Graph node kind, derived from the component's type (type-* GitHub topic). Repos outside the
// configured org are 'external-repo' (out of scope). type-third-party-service never applies to a
// cloned repo.
const TYPE_KIND = { 'Client': 'client', 'Service': 'service', 'Library': 'library', 'Assets': 'assets', 'Tests': 'tests', 'Third-Party Service': 'external', 'Firmware': 'firmware', 'Infrastructure': 'infrastructure', 'Hardware': 'hardware', 'Data': 'data', 'Config': 'config' }
const remoteFor = (folder) => remotes[folder] ?? null
// The same org test discovery used (repos.mjs → _paths.mjs `inOrg`), so a repo accepted there
// can't be flipped out of scope here.
const isOrgRepo = (folder) => inOrg(remoteFor(folder))
const kindFor = (folder) => {
  if (!isOrgRepo(folder)) return 'external-repo'
  return TYPE_KIND[inventoryFor(folder)?.type] || 'service'
}

// Per-repo FE→backend notes (env vars + backend hosts, curated) — repo-extra.json `feToBe`.
const feToBe = repoExtra.feToBe || {}

const allScanned = gather.map(g => {
  const tv = g.tooling
  const pick = (o) => o ? (o.resolved ?? o.declared ?? null) : null
  const deploy = (wf[g.folder]||[]).filter(w=>w.deploys).map(w=>({
    workflow:w.file, triggers:w.triggers, branches:w.branches, environments:w.environments, target:w.target,
  }))
  const m = mg[g.folder]
  return {
    folder: g.folder,
    // canonical GitHub name — follows renames detected by sync-names even before the local folder moves
    displayName: renamedBasename[g.folder] || g.folder,
    kind: kindFor(g.folder),
    inOrg: isOrgRepo(g.folder),
    remote: remoteFor(g.folder),
    name: g.name,
    version: g.version,
    defaultBranch: g.defaultBranch,
    lastCommit: g.lastCommitDate,
    externals: g.externals || [],
    endpoints: g.endpoints || [],
    endpointLinks: g.endpointLinks || {},
    liveUrl: g.liveUrl ?? null,
    apiUrl: g.apiUrl ?? null,
    swagger: g.swagger ?? null,
    internalDeps: g.internalDeps.map(d=>({name:d.name,version:d.version,dev:d.dev})),
    legacyPackages: g.legacyPackages,
    toolingVersions: {
      react: pick(tv.react), vite: pick(tv.vite), typescript: pick(tv.typescript),
      mui: pick(tv.mui),
      storybook: tv.storybook.pkg ? `${tv.storybook.pkg}@${pick(tv.storybook)}` : null,
      node: tv.node.value ? `${tv.node.value} (${tv.node.source})` : null,
      buildTool: g.scripts?.start?.includes('craco')||g.scripts?.start?.includes('react-scripts')||g.scripts?.build?.includes('react-scripts') ? 'CRA/craco (react-scripts)' : (pick(tv.vite) ? 'vite' : (g.scripts?.dev?.includes('astro')?'astro':'other')),
    },
    moduleGraph: m ? { method:m.method, crossFolderEdges:m.crossFolderEdges, srcFiles:m.srcFiles??null, topFolders:m.topFolders??null, edges:m.edges } : { method:'grep', crossFolderEdges:0, edges:[], note:'no src/ dir' },
    deployment: deploy.length?deploy:[{note:'no deploying workflow detected'}],
    feToBe: feToBe[g.folder] || { method:'grep', backends:[] },
  }
})

// attach the inventory record (from GitHub topics/description/properties) to each scanned repo
for (const r of allScanned) { const e = inventoryFor(r.folder); if (e) r.inventory = e }
// Two local clones of the SAME GitHub repo (e.g. a leftover checkout under the pre-rename folder
// name) would draw duplicate cards — keep the clone whose folder matches the canonical repo
// basename (else the freshest), and surface the shadowed folder in pipeline health.
const byRemote = {}
for (const r of allScanned) if (r.remote) (byRemote[r.remote.toLowerCase()] = byRemote[r.remote.toLowerCase()] || []).push(r)
const duplicateClones = []
const shadowed = new Set()
for (const group of Object.values(byRemote)) {
  if (group.length < 2) continue
  const base = group[0].remote.split('/').pop().replace(/\.git$/i, '')
  const keep = group.find((r) => r.folder === base)
    || [...group].sort((a, b) => String(b.lastCommit || '').localeCompare(String(a.lastCommit || '')))[0]
  for (const r of group) if (r !== keep) { shadowed.add(r.folder); duplicateClones.push(`${r.folder} — same repo as ${keep.folder} (stale clone, remove it)`) }
}
// The map shows CURATED components only — repos that carry inventory topics. The org-wide CI
// clone also pulls in POCs, archived repos, themes, load-test harnesses and rename-duplicates;
// those have no topics, so they're excluded here and surfaced as a curation backlog
// (validation.uncuratedRepos). Repos outside the configured org have no inventory either.
const repos = allScanned.filter(r => r.inventory && !shadowed.has(r.folder))
// Service identity for each drawn repo (backlog #16, Phase 1 — additive): serviceId = its inventory
// name, serviceRepo = its own folder. Default is identity, so the viz (still folder-keyed) is unchanged.
for (const r of repos) Object.assign(r, serviceIdentity(r.inventory?.name ?? r.folder, r.folder, serviceMap))
const uncuratedRepos = allScanned.filter(r => !r.inventory && !shadowed.has(r.folder) && !OUTSIDE.includes(r.folder) && !ignored.has(r.folder)).map(r => r.folder)
// "New" repos: created on GitHub within the last ARCH_NEW_REPO_DAYS (default 90). Replaces the
// old hardcoded last-known-repo snapshot — derived from live metadata, and self-expiring.
const NEW_REPO_DAYS = Number(process.env.ARCH_NEW_REPO_DAYS) > 0 ? Number(process.env.ARCH_NEW_REPO_DAYS) : 90
const newlyDiscovered = repos
  .filter((r) => r.inventory?.createdAt && Date.now() - Date.parse(r.inventory.createdAt) < NEW_REPO_DAYS * 86400000)
  .map((r) => r.folder)

// The design-system package(s) that resolve to the single `ui` hub card, from config.json
// `uiPackages`. List every name a consumer might pin — a package mid-rename is referenced under
// both, and both should collapse onto the one hub. Unset => no hub card is drawn.
// Kept in sync with the viz default in graph.js (DEFAULT_UI_PACKAGES).
const UI_PACKAGES = new Set(Array.isArray(appConfig.uiPackages) ? appConfig.uiPackages : [])
const isUiPkg = (name) => UI_PACKAGES.has(name)
// Exclude the design system itself (it yalc-links its own package during local dev, which would
// otherwise register as a self-consumer with a bogus file: version).
const uiConsumers = repos.filter(r=>!isUiPkg(r.name) && r.internalDeps.some(d=>isUiPkg(d.name)))
  .map(r=>({repo:r.folder, version:r.internalDeps.find(d=>isUiPkg(d.name)).version}))
const legacyPackages = repos.filter(r=>r.legacyPackages).map(r=>r.folder)

const driftFor = (getter) => {
  const map = {}
  for (const r of repos) { const v = getter(r); if (v) (map[v]=map[v]||[]).push(r.folder) }
  const distinct = Object.keys(map)
  return distinct.length>1 ? Object.entries(map).map(([version,reposIn])=>({version,repos:reposIn})) : []
}

// Folder name(s) the design-system repo is checked out under, so its own source version can be
// compared against what consumers pin. config.json `uiHubFolders`; defaults to 'ui'.
const UI_HUB_FOLDERS = Array.isArray(appConfig.uiHubFolders) && appConfig.uiHubFolders.length
  ? appConfig.uiHubFolders : ['ui']
const UI_DRIFT_KEY = [...UI_PACKAGES][0] || 'design system'

const versionDrift = {
  [UI_DRIFT_KEY]: uiConsumers.map(c=>({repo:c.repo,version:c.version}))
    // the library source HEAD version, read from the ui repo's own package.json (never hardcode
    // it — a stamped literal fossilizes and gets re-emitted nightly as if measured)
    .concat((()=>{ const v = repos.find(r=>UI_HUB_FOLDERS.includes(r.folder))?.version; return v ? [{repo:'ui (library source HEAD)',version:v}] : [] })()),
  mui: driftFor(r=> r.toolingVersions.mui),
  storybook: driftFor(r=> r.toolingVersions.storybook),
  node: driftFor(r=> r.toolingVersions.node),
  react: driftFor(r=> r.toolingVersions.react),
  typescript: driftFor(r=> r.toolingVersions.typescript),
  vite: driftFor(r=> r.toolingVersions.vite),
}

// HAND-WRITTEN AUDIT SNAPSHOT — not derived. A place for dated observations a scan can't make
// ("both clients consume the design system via yalc, so the installed version can differ from
// the pin"). Emitted under an explicit asOf so a consumer can tell these from the
// nightly-measured fields around them. Add your own and bump NOTES_AS_OF; an empty list is fine.
const NOTES_AS_OF = null
const notes = []

// Pipeline self-checks surfaced in the viz (see graph.js for the Unclassified-repo check).
const orgRepos = repos.filter((r) => r.inOrg !== false && r.kind !== 'external-repo')
const validation = {
  newlyDiscovered,                                                  // created on GitHub in the last NEW_REPO_DAYS
  unclonedOrgRepos: process.env.ATLAS_DISCOVER === '1' ? uncloned() : [], // on the org, missing locally
  staleClones: orgRepos.filter((r) => !r.lastCommit).map((r) => r.folder), // git read failed -> unreliable
  duplicateClones, // two local checkouts of the same GitHub repo (stale pre-rename folder)
  repoRenames: (nameDrift?.renames || []).map((r) => `${r.from} → ${r.to} (${[...r.foundIn].join(', ')})`),
  repoMissingOnGitHub: (nameDrift?.missing || []).map((r) => `${r.repo} (${[...r.foundIn].join(', ')})`),
  uncuratedRepos, // org repos scanned but with no inventory topics — not drawn; curate to include
  // repo-backed components that ARE on the map (have a type) but are half-curated — missing
  // owner/status/description, so they render but with gaps. Nudge owners to finish the topics.
  incompleteCuration: inventory
    .filter((e) => e.repoName && e.type)
    .map((e) => {
      const missing = ['owner', 'status', 'description'].filter((f) => !e[f])
      return missing.length ? `${e.name} — missing ${missing.join(', ')}` : null
    })
    .filter(Boolean),
  // Archived on GitHub but the status topic still reads live. The repo is read-only, so the
  // `status-*` topic can't be re-curated in place — flag it for a human to resolve (unarchive +
  // fix the topic, or record the decommission) instead of silently forcing it to Removed.
  statusMismatch: inventory
    .filter((e) => e.archived && e.status !== 'Removed')
    .map((e) => `${e.name} — archived on GitHub but status is ${e.status ? `"${e.status}"` : 'unset'} (should be Removed)`),
}

// ---- Azure overlay (azure-resources.json, written by azure-gather.mjs; optional) ----
// Maps what is ACTUALLY deployed (storage/Front Door/ACR, read via the az CLI) onto the
// repos and inventory entries, and cross-checks it against the curated data.
let azure = null
try { azure = JSON.parse(fs.readFileSync(path.join(AUDIT, 'azure-resources.json'), 'utf8')) } catch {}

// Azure app key ({env}{app}website resource name → repo folder) and ACR image name → inventory
// name (covers renames). OWNER-OWNED via repo custom properties, falling back to repo-extra.json:
//   azure-app-key  — the repo's Azure static-site app key(s), comma/space-separated for several
//                    (e.g. skytrack maps skytrack + skytrackv2). Builds key → repo folder.
//   acr-image      — the ACR image name when it differs from the component. Builds image → inv name.
// Properties merge OVER the repo-extra fallback (property wins), so an owner can claim their app's
// Azure naming without a central edit.
const ghMeta = readJson(path.join(AUDIT, 'github-meta.json'))
const AZURE_APP_MAP = { ...(repoExtra.azureAppMap || {}) }
const ACR_ALIAS = { ...(repoExtra.acrAlias || {}) }
// First-party container registries (config.json `containerRegistries`). Images from anywhere else
// are recorded but never scaffolded into the inventory. Unset => trust every registry found.
const ACR_REGISTRIES = Array.isArray(appConfig.containerRegistries) ? appConfig.containerRegistries : []
for (const [name, r] of Object.entries(ghMeta?.repos || {})) {
  const props = r.props || {}
  for (const key of String(props['azure-app-key'] || '').split(/[\s,]+/).filter(Boolean)) AZURE_APP_MAP[key] = name
  if (props['acr-image']) ACR_ALIAS[props['acr-image']] = inventoryFor(name)?.name || name
}

if (azure) {
  const byFolder = Object.fromEntries(repos.map((r) => [r.folder, r]))
  // FE apps -> repos: merge env grids; on overlap (skytrack vs skytrackv2) keep the freshest deploy
  for (const [app, a] of Object.entries(azure.apps || {})) {
    const r = byFolder[AZURE_APP_MAP[app]]
    if (!r) continue
    r.azure = r.azure || { envs: {} }
    const moduleUrl = (x) => (x?.path && x.domains?.[0]) ? x.domains[0] + x.path : null
    for (const [env, e] of Object.entries(a.envs)) {
      const cur = r.azure.envs[env]
      if (cur && (cur.deployed || '') >= (e.deployed || '')) {
        if (!cur.domains?.length && e.domains?.length) cur.domains = e.domains
        // path-routed module folding into a full site (pharma -> intervention-client): keep its URL visible
        const m = moduleUrl(e)
        if (m) cur.modules = [...new Set([...(cur.modules || []), m])]
        continue
      }
      const m = moduleUrl(cur)
      r.azure.envs[env] = {
        domains: e.domains?.length ? e.domains : (cur?.domains || []),
        deployed: e.deployed || null, storage: e.storage || null, path: e.path || null,
        modules: [...new Set([...(cur?.modules || []), ...(m ? [m] : [])])],
      }
    }
  }
  for (const r of repos) {
    if (!r.azure) continue
    r.azure.lastDeploy = Object.values(r.azure.envs).map((e) => e.deployed).filter(Boolean).sort().pop() || null
    const prod = r.azure.envs.prod
    if (prod?.domains?.length) r.liveUrl = prod.domains[0] // real prod domain beats the curated {env} template
  }

  // BE services: ACR image last-push + infra resources -> inventory entries
  const invByName = Object.fromEntries(inventory.map((e) => [e.name.toLowerCase(), e]))
  const invByRepo = Object.fromEntries(inventory.filter((e) => e.repoName).map((e) => [e.repoName.toLowerCase(), e]))
  const invFor = (key) => invByName[key.toLowerCase()] || invByRepo[key.toLowerCase()] || null
  // ACR services with no inventory entry: if a GitHub repo of the same name exists, scaffold
  // an entry so the service shows up in the table/matrix as "awaiting curation" (set topics
  // on the repo to complete it) rather than only as a warning chip. (ghMeta loaded above.)
  const acrUnknown = [], scaffolded = []
  for (const [registry, repoMap] of Object.entries(azure.acr || {})) {
    for (const [repo, meta] of Object.entries(repoMap)) {
      // Prefer the alias target, but fall back to the raw repo name so an existing entry that
      // happens to match the repo (e.g. a curated `intervention-backend`) is merged into rather
      // than duplicated by a scaffold (the alias points at a differently-named entry).
      const e = invFor(ACR_ALIAS[repo] || repo) || (ACR_ALIAS[repo] && invFor(repo))
      if (e) { e.azure = { ...(e.azure || {}), image: `${registry}.azurecr.io/${repo}`, lastPush: meta.lastPush }; continue }
      // Only scaffold inventory entries from registries the config claims as first-party — an
      // upstream mirror's images aren't components. Unset => every discovered registry counts.
      if ((ACR_REGISTRIES.length && !ACR_REGISTRIES.includes(registry)) || repo.includes('/')) continue
      const gm = ghMeta?.repos?.[repo]
      // deliberately-excluded repos (arch-map-ignore) shouldn't be scaffolded or flagged for curation
      if (gm && (gm.topics || []).includes('arch-map-ignore')) continue
      if (gm) {
        const entry = {
          name: repo, abbr: '', type: 'Service', status: '', owner: '', applications: [],
          description: gm.description || '', contact: '', introDate: '', sunsetDate: '',
          comment: '', doc: '',
          repo: gm.url, repoName: repo, scaffold: true,
          azure: { image: `${registry}.azurecr.io/${repo}`, lastPush: meta.lastPush },
        }
        inventory.push(entry)
        invByName[repo.toLowerCase()] = entry
        invByRepo[repo.toLowerCase()] = entry
        scaffolded.push(repo)
      } else acrUnknown.push(repo)
    }
  }
  for (const res of azure.infra || []) {
    const e = res.service && invFor(ACR_ALIAS[res.service] || res.service)
    if (e) { e.azure = e.azure || {}; (e.azure.infra = e.azure.infra || []).push({ name: res.name, type: res.type.split('/').pop(), env: res.env }) }
  }

  // drift checks -> pipeline-health popover
  const recent = (iso, days) => iso && (Date.now() - new Date(iso).getTime()) < days * 86400000
  Object.assign(validation, {
    azureUnmappedApps: Object.entries(azure.apps || {})
      .filter(([app, a]) => !AZURE_APP_MAP[app] && Object.values(a.envs).some((e) => e.domains?.length))
      .map(([app, a]) => {
        const e = a.envs.prod || Object.values(a.envs).find((x) => x.domains?.length)
        return `${app} → ${e.domains[0]}${e.path || ''}`
      }),
    azureEnvDrift: repos.filter((r) => r.azure).map((r) => {
      const wfEnvs = new Set(r.deployment.flatMap((d) => d.environments || []))
      if (!wfEnvs.size) return null
      const extra = Object.keys(r.azure.envs).filter((e) => !wfEnvs.has(e) && e !== 'sandbox')
      return extra.length ? `${r.folder}: deployed ${extra.join(', ')} not in workflows` : null
    }).filter(Boolean),
    azureRemovedButDeployed: inventory
      .filter((e) => /removed|sunsetting/i.test(e.status) && recent(e.azure?.lastPush, 180))
      .map((e) => `${e.name} (image pushed ${e.azure.lastPush.slice(0, 10)})`),
    azureNeedsCuration: scaffolded.map((r) => `${r} — set type-/owner-/status-/app- topics on the repo`),
    azureAcrNotInInventory: acrUnknown,
    // mappings in this file that point at Azure names that no longer exist (resource renamed/removed)
    azureStaleMappings: [
      ...Object.keys(AZURE_APP_MAP).filter((k) => !azure.apps?.[k])
        .map((k) => `azureAppMap '${k}' — no such app in Azure anymore`),
      ...(() => {
        const known = new Set([
          ...Object.values(azure.acr || {}).flatMap((r) => Object.keys(r)),
          ...(azure.infra || []).map((i) => i.service).filter(Boolean),
        ])
        return Object.keys(ACR_ALIAS).filter((k) => !known.has(k))
          .map((k) => `acrAlias '${k}' — not found in ACR or infra names`)
      })(),
      // …and alias VALUES that resolve to no inventory component (component renamed after the
      // alias was written): the infra loop above has no raw-name fallback, so a stale value
      // silently drops that component's azure.infra.
      ...Object.entries(ACR_ALIAS).filter(([, target]) => !invFor(target))
        .map(([k, target]) => `acrAlias '${k}' → '${target}' — no such inventory component (renamed?)`),
    ],
  })
}

// ---- derived language / framework (taxonomy: measured, never curated) ----------------------
// Every inventory component gets a `language` (+ `framework` where known). Priority per entry:
//   1. build-file scan (backend-tooling.json — "Java 21" / "Quarkus 3.20.4"), matched by the
//      owning repo (serviceRepo covers monorepo services like device-data-*)
//   2. FE toolingVersions from the clone (TypeScript/JavaScript + React/Vite version)
//   3. GitHub primaryLanguage (github-meta.json) — the zero-curation fallback for everything else
const beStackByRepo = {}
for (const [folder, s] of Object.entries(beTooling?.scanned || {})) {
  beStackByRepo[(s.repoName || folder).toLowerCase()] = { language: s.java || 'Java', framework: s.framework || null }
}
const feStackOf = (r) => {
  const tv = r?.toolingVersions
  if (!tv || (!tv.typescript && !tv.react && !tv.vite && !tv.node && !tv.buildTool)) return null
  return {
    language: tv.typescript ? 'TypeScript' : 'JavaScript',
    framework: tv.react ? `React ${String(tv.react).replace(/^[~^>=<\s]+/, '')}` : null,
  }
}
const repoByFolderOrName = {}
for (const r of repos) { repoByFolderOrName[r.folder.toLowerCase()] = r; if (r.displayName) repoByFolderOrName[r.displayName.toLowerCase()] = r }
for (const e of inventory) {
  const owningRepo = (e.serviceRepo || e.repoName || '').toLowerCase()
  const stack = beStackByRepo[owningRepo]
    || feStackOf(repoByFolderOrName[owningRepo])
    || (ghMeta?.repos?.[e.repoName]?.language ? { language: ghMeta.repos[e.repoName].language, framework: null } : null)
  if (stack) { e.language = stack.language; if (stack.framework) e.framework = stack.framework }
}
for (const r of repos) {
  const stack = feStackOf(r) || (ghMeta?.repos?.[r.displayName || r.folder]?.language ? { language: ghMeta.repos[r.displayName || r.folder].language, framework: null } : null)
  if (stack) { r.language = stack.language; if (stack.framework) r.framework = stack.framework }
}

// ---- framework adoption (backend counterpart of uiConsumers) ---------------------------
// Which services build on which curated internal framework (backend-extra.json `frameworkDeps`,
// extracted from build files by backend-scan). Keyed by framework name → consumers with version.
const frameworkConsumers = {}
for (const [folder, s] of Object.entries(beTooling?.scanned || {})) {
  const repoComponent = (byRepo[s.repoName || folder] || [])[0]?.name || s.repoName || folder
  for (const [fw, info] of Object.entries(s.frameworks || {})) {
    ;(frameworkConsumers[fw] = frameworkConsumers[fw] || []).push({ name: repoComponent, version: info.version, artifacts: info.artifacts })
  }
}

const missingRepos = [] // locally-present-but-uncloned repos; nothing detects these today

const out = {
  org:ORG,
  generatedAt:new Date().toISOString(),
  // Only the directory NAME, never the absolute path: this file is committed, and whoever ran the
  // pipeline shouldn't publish their home directory layout along with the model. Enough to tell one
  // checkout dir from another when a run looks wrong.
  scanRoot: path.basename(ROOT),
  azure: azure ? { generatedAt: azure.generatedAt, subscription: azure.subscription?.name, tenant: azure.subscription?.tenant, warnings: azure.warnings } : null,
  validation,
  inventory,
  integrations,
  backendTopology,
  // missingRepos was a hardcoded July-2026 local-audit observation (a folder holding only .idea)
  // restamped nightly as if re-measured; nothing detects that condition in CI and nothing consumes
  // the field, so it's now honestly empty and `missing` is derived from it.
  missingRepos,
  repoCounts:{ withPackageJson:repos.length, missing:missingRepos.length, inOrg:repos.filter(r=>r.inOrg).length, outsideOrg:repos.filter(r=>!r.inOrg).length },
  repos,
  uiConsumers,
  frameworkConsumers,
  legacyPackages,
  versionDrift,
  // dated hand-audit observations — see NOTES_AS_OF above
  notes: { asOf: NOTES_AS_OF, items: notes },
}
fs.writeFileSync(path.join(AUDIT,'fe-architecture.json'), JSON.stringify(out,null,2))
console.log('wrote fe-architecture.json; repos:',repos.length)
