import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { ROOT, AUDIT, maybeFetch } from './_paths.mjs'
import { repos } from './repos.mjs'
import { extractEndpointsFromText, extractTemplateEndpointsFromText, extractUrlEndpointsFromText } from './lib/endpoints.mjs'
const REPOS = repos.all

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

const resolvedVersion = (repoDir, pkg) => {
  const p = path.join(repoDir, 'node_modules', ...pkg.split('/'), 'package.json')
  const j = readJson(p)
  if (j?.version) return j.version
  return null
}

const detectNode = (repoDir, pj) => {
  const nvmrc = path.join(repoDir, '.nvmrc')
  if (fs.existsSync(nvmrc)) return { source: '.nvmrc', value: fs.readFileSync(nvmrc, 'utf8').trim() }
  if (pj?.volta?.node) return { source: 'volta', value: pj.volta.node }
  if (pj?.engines?.node) return { source: 'engines', value: pj.engines.node }
  return { source: null, value: null }
}

const defaultBranch = (repoDir) => {
  try {
    const out = execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd: repoDir, stdio: ['ignore','pipe','ignore'] }).toString().trim()
    return out.replace('refs/remotes/origin/', '')
  } catch {}
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoDir, stdio: ['ignore','pipe','ignore'] }).toString().trim()
  } catch {}
  return null
}

// Freshness = the last commit on the REMOTE default branch, not local HEAD: a local checkout is
// often behind origin (or parked on an old branch), which made active repos look months stale.
const lastCommitDate = (repoDir) => {
  const at = (ref) => { try { return execSync(`git log -1 --format=%cI ${ref}`, { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return null } }
  let branch = null
  try { branch = execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().replace('refs/remotes/', '') } catch {}
  return (branch && at(branch)) || at('origin/HEAD') || at('HEAD')
}

const collectInternalDeps = (pj) => {
  const out = []
  const buckets = [
    ['dependencies', false], ['peerDependencies', false], ['devDependencies', true],
  ]
  for (const [key, dev] of buckets) {
    const d = pj?.[key] || {}
    for (const [name, version] of Object.entries(d)) {
      // First-party packages, identified by npm scope (config.json `internalScopes`). List every
      // scope your org publishes under, including ones you've migrated away from — older pins in
      // un-updated repos still reference them, and they're exactly the drift worth seeing.
      if (INTERNAL_SCOPES.some((scope) => name.startsWith(scope))) out.push({ name, version, dev, bucket: key })
    }
  }
  return out
}

// Unscoped, pre-migration aliases of a first-party package (config.json `legacyPackages`) — a repo
// still depending on the bare name hasn't been moved onto the scoped one. Surfaced as a nudge.
const detectLegacyPackages = (pj) => {
  const all = { ...(pj?.dependencies||{}), ...(pj?.devDependencies||{}), ...(pj?.peerDependencies||{}) }
  return LEGACY_PACKAGES.some((name) => Object.prototype.hasOwnProperty.call(all, name))
}

const tooling = (repoDir, pj) => {
  const allDeps = { ...(pj?.dependencies||{}), ...(pj?.devDependencies||{}), ...(pj?.peerDependencies||{}) }
  const get = (pkg) => ({ declared: allDeps[pkg] ?? null, resolved: resolvedVersion(repoDir, pkg) })
  const storybookPkg = allDeps['@storybook/react-vite'] ? '@storybook/react-vite' : (allDeps['storybook'] ? 'storybook' : null)
  const node = detectNode(repoDir, pj)
  return {
    react: get('react'),
    vite: get('vite'),
    typescript: get('typescript'),
    mui: get('@mui/material'),
    storybook: storybookPkg ? { pkg: storybookPkg, ...get(storybookPkg) } : { pkg: null, declared: null, resolved: null },
    node,
  }
}

const listWorkflows = (repoDir) => {
  const dir = path.join(repoDir, '.github', 'workflows')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).map(f => ({
    file: f, content: fs.readFileSync(path.join(dir, f), 'utf8'),
  }))
}

const feToBeHeuristics = (repoDir, pj) => {
  const allDeps = { ...(pj?.dependencies||{}), ...(pj?.devDependencies||{}) }
  const signals = {
    orval: !!allDeps['orval'],
    openapiTypescript: !!allDeps['openapi-typescript'],
    openapiGenerator: !!(allDeps['@openapitools/openapi-generator-cli'] || allDeps['openapi-generator']),
    axios: !!allDeps['axios'],
  }
  const found = { specFiles: [], clientFolders: [], orvalConfig: null }
  const candidates = [
    'orval.config.ts','orval.config.js','orval.config.cjs','orval.config.mjs',
    'openapi.yaml','openapi.yml','openapi.json','swagger.yaml','swagger.yml','swagger.json',
  ]
  for (const c of candidates) {
    if (fs.existsSync(path.join(repoDir, c))) { found.specFiles.push(c); if (c.startsWith('orval')) found.orvalConfig = c }
  }
  for (const cf of ['src/api','src/generated','api','src/services/api','generated']) {
    if (fs.existsSync(path.join(repoDir, cf))) found.clientFolders.push(cf)
  }
  return { signals, found }
}

// Curated per-repo knowledge (hosts, non-npm SaaS, purposes, …) lives in repo-extra.json —
// data, not code — so it can be edited without touching the pipeline. Missing file → empty overlay.
const repoExtra = readJson(path.join(AUDIT, 'repo-extra.json')) || {}
const appConfig = readJson(path.join(AUDIT, 'config.json')) || {}
// npm scopes your org publishes under — what counts as an "internal dependency" edge on the map.
const INTERNAL_SCOPES = (Array.isArray(appConfig.internalScopes) ? appConfig.internalScopes : [])
  .map((s) => (s.endsWith('/') ? s : `${s}/`))
const LEGACY_PACKAGES = Array.isArray(appConfig.legacyPackages) ? appConfig.legacyPackages : []
// Your own API domains, as an rg alternation — see extractEndpoints step 3. Each entry is matched
// as a literal domain suffix, so "example.com" matches api.example.com but not notexample.com.
const API_DOMAIN_RE = (Array.isArray(appConfig.apiDomains) ? appConfig.apiDomains : [])
  .map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&')).join('|') || null

// External / third-party integrations: auto-detected from package.json deps via the built-in
// vendor patterns below (stable npm→SaaS mappings, not org-specific), extended by
// repo-extra.json `saasPatterns` ([regexSource, label] pairs).
const SAAS_BY_DEP = [
  [/^@sentry\//, 'Sentry'],
  [/launchdarkly|ldclient-js/, 'LaunchDarkly'],
  [/^@datadog\/|dd-trace/, 'Datadog'],
  [/posthog/, 'PostHog'],
  [/mixpanel/, 'Mixpanel'],
  [/amplitude/, 'Amplitude'],
  [/mapbox-gl/, 'Mapbox'],
  [/@react-google-maps|google-maps/, 'Google Maps'],
  [/react-ga|react-gtm|gtag/, 'Google Tag Manager'],
  [/@mui\/x-/, 'MUI X (licensed)'],
  [/i18next/, 'i18next'],
  [/@fortawesome\/(fontawesome-pro|pro-)/, 'FontAwesome Pro'],
  [/openai/, 'OpenAI'],
  [/@tanstack\/react-query/, 'TanStack Query'],
  ...(repoExtra.saasPatterns || []).map(([src, label]) => [new RegExp(src), label]),
]
// SaaS a repo uses that isn't an npm dep (repo-extra.json externals.curated), and detected deps
// the team says aren't actually used (externals.exclude — e.g. a repo ships `openai` unused).
const CURATED_EXTERNALS = repoExtra.externals?.curated || {}
const EXCLUDE_EXTERNALS = repoExtra.externals?.exclude || {}
const detectExternals = (pj, folder) => {
  const deps = { ...(pj?.dependencies || {}), ...(pj?.devDependencies || {}) }
  const found = new Map()
  for (const name of Object.keys(deps)) for (const [re, label] of SAAS_BY_DEP) if (re.test(name)) found.set(label, 'dep:' + name)
  for (const label of (CURATED_EXTERNALS[folder] || [])) if (!found.has(label)) found.set(label, 'curated')
  for (const label of (EXCLUDE_EXTERNALS[folder] || [])) found.delete(label)
  return [...found].map(([name, via]) => ({ name, via }))
}

// Where each app is hosted + its primary API + API docs ({env} = dev/test/pre/prod/...).
// OWNER-OWNED via repo custom properties `live-url` / `api-url` / `swagger-url` (read from the
// committed github-meta.json, refreshed nightly by github-inventory.mjs), falling back per-field
// to repo-extra.json `hosts`. Reading the committed metadata means a just-set property takes
// effect on the NEXT run (hosts are stable, so the one-run lag is harmless). Property wins.
const ghProps = (() => {
  const meta = readJson(path.join(AUDIT, 'github-meta.json'))
  const out = {}
  for (const [name, r] of Object.entries(meta?.repos || {})) if (r.props) out[name] = r.props
  return out
})()
const overrodeHost = []
const hostsFor = (folder) => {
  const fb = repoExtra.hosts?.[folder] || {}
  const p = ghProps[folder] || {}
  const merged = {
    live: p['live-url'] ?? fb.live ?? null,
    api: p['api-url'] ?? fb.api ?? null,
    swagger: p['swagger-url'] ?? fb.swagger ?? null,
  }
  for (const [k, prop] of [['live', 'live-url'], ['api', 'api-url'], ['swagger', 'swagger-url']]) {
    if (p[prop] != null && fb[k] != null && p[prop] !== fb[k]) overrodeHost.push(`${folder}.${k}: property "${prop}" overrides repo-extra`)
  }
  return merged
}
const swaggerFor = (folder) => {
  const h = hostsFor(folder)
  if (h.swagger) return h.swagger
  if (h.api) return `https://${h.api.replace('{env}', 'dev')}/q/swagger-ui/` // Quarkus default
  return null
}

// Backend resources the FE calls, from two structured sources (merged): literal hook args
// use*Endpoints('path'), and `${apiUrl}/path` template literals centralized in the hook definition.
// A repo can use both — e.g. skytrack-client has one use…('q/health') call plus many template paths —
// so the template pass must NOT be skipped just because a literal was found. Apps with no hook literal
// at all fall back to grepped backend URLs. Demo/test files are excluded from the template pass so
// story fixtures (`${DEFAULT_URL}/first`, `gateway/22222/...`) don't leak in as endpoints.
const extractEndpoints = (repoDir) => {
  const src = path.join(repoDir, 'src')
  if (!fs.existsSync(src)) return []
  const run = (pattern, flags = '') => { try { return execSync(`rg -oIN ${flags} --no-filename -g '!node_modules' "${pattern}" '${src}'`, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 }) } catch (e) { return e.stdout ? e.stdout.toString() : '' } }
  // whole matching lines, pattern single-quoted so the shell leaves ${…} untouched; skip demo/test files
  const runLines = (pattern) => { try { return execSync(`rg -IN --no-filename -g '!node_modules' -g '!*.stories.*' -g '!*.test.*' -g '!*.spec.*' -g '!*.cy.*' -g '!*.mdx' '${pattern}' '${src}'`, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 }) } catch (e) { return e.stdout ? e.stdout.toString() : '' } }

  // 1) use<Name>Endpoints('resource/path') literal args — single/double/backtick quotes, multiline
  const set = extractEndpointsFromText(run("use[A-Za-z]+Endpoints\\([^)]{0,200}", '-U'))
  const hadHookLiteral = set.size > 0

  // 2) + `${apiUrl}/…` template paths centralized in the hook definition (e.g. skytrack-client)
  extractTemplateEndpointsFromText(runLines('\\$\\{[A-Za-z0-9_]*(URL|Url|API|Api|BASE|Base|HOST|Host|ENDPOINT|Endpoint)[A-Za-z0-9_]*\\}'), set)

  // structured endpoints (hook + template) are trusted → return uncapped, no URL fallback
  if (hadHookLiteral) return [...set].sort()

  // 3) host-only app with no hook literal: add grepped backend URLs, capping the noisier fallback.
  // Scoped to your own API domains (config.json `apiDomains`, e.g. ["api.example.com", "example.dev"])
  // so a CDN or docs link doesn't read as an endpoint. With none configured this step is skipped and
  // only the structured hook/template endpoints above are reported.
  if (!API_DOMAIN_RE) return [...set].sort()
  const urlRaw = run(`https?://[A-Za-z0-9._-]+\\.(${API_DOMAIN_RE})[A-Za-z0-9./_-]*`)
  extractUrlEndpointsFromText(urlRaw, set)
  return [...set].sort().slice(0, 24)
}

const result = []
for (const folder of REPOS) {
  const repoDir = path.join(ROOT, folder)
  maybeFetch(repoDir)
  const pj = readJson(path.join(repoDir, 'package.json'))
  result.push({
    folder,
    externals: detectExternals(pj, folder),
    endpoints: extractEndpoints(repoDir),
    liveUrl: hostsFor(folder).live,
    apiUrl: hostsFor(folder).api,
    swagger: swaggerFor(folder),
    name: pj?.name ?? null,
    version: pj?.version ?? null,
    defaultBranch: defaultBranch(repoDir),
    lastCommitDate: lastCommitDate(repoDir),
    internalDeps: collectInternalDeps(pj),
    legacyPackages: detectLegacyPackages(pj),
    tooling: tooling(repoDir, pj),
    workflows: listWorkflows(repoDir).map(w => ({ file: w.file, len: w.content.length })),
    feToBe: feToBeHeuristics(repoDir, pj),
    scripts: pj?.scripts ?? {},
    deps_count: Object.keys(pj?.dependencies||{}).length,
  })
}

// Swagger deep-links: fetch each reachable OpenAPI spec and map endpoint -> tag (#/tag) anchor.
const fetchSpec = async (apiHost) => {
  const url = `https://${apiHost.replace('{env}', 'dev')}/q/openapi?format=json`
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
    if (!r.ok) return null
    return JSON.parse(await r.text())
  } catch { return null }
}
const tagLinkMap = (spec, swaggerBase) => {
  const map = {}
  for (const [p, methods] of Object.entries(spec.paths || {})) {
    if (!methods || typeof methods !== 'object') continue // malformed spec: null/scalar path item
    const op = methods.get || Object.values(methods).find((x) => x && x.tags)
    const tag = op && op.tags && op.tags[0]
    if (!tag) continue
    const key = p.replace(/^\//, '').replace(/\{[^}]*\}/g, '{}')
    if (!map[key]) map[key] = `${swaggerBase}#/${encodeURIComponent(tag)}`
  }
  return map
}
await Promise.all(result.map(async (r) => {
  if (!r.apiUrl || !r.swagger || !(r.endpoints || []).length) return
  const spec = await fetchSpec(r.apiUrl)
  if (!spec) return
  const map = tagLinkMap(spec, r.swagger)
  const links = {}
  for (const e of r.endpoints) { const key = e.replace(/\{[^}]*\}/g, '{}'); if (map[key]) links[e] = map[key] }
  if (Object.keys(links).length) { r.endpointLinks = links; console.log(`  deeplinks ${r.folder}: ${Object.keys(links).length}/${r.endpoints.length}`) }
}))

fs.writeFileSync(path.join(AUDIT,'scripts/gather-out.json'), JSON.stringify(result, null, 2))
if (overrodeHost.length) console.log(`  hosts from custom properties (repo-extra.json fallback now redundant): ${[...new Set(overrodeHost)].join('; ')}`)
console.log('done; repos:', result.length)
