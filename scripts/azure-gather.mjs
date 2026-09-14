// Azure inventory gather (read-only) — makes the map reflect what is ACTUALLY deployed.
//
// Uses the az CLI (the operator's portal-Reader access) to collect:
//   1. FE apps per environment: storage accounts named {env}{app}website, Azure Front Door
//      routes (route name = {env}{app}website) -> real custom domains per app+env
//   2. FE deploy freshness: $web/index.html last-modified per website storage account
//   3. BE deploy freshness: last image push per container-registry repository
//   4. Infra resources (Postgres/SQL/Cosmos/Event Hubs/...) parsed into service+env
//
// Degrades gracefully: if az is missing or not logged in, the step is skipped and any
// existing azure-resources.json is left as-is (same spirit as the Swagger fetch).
// Skipped when azure-resources.json is fresh (<1h) unless ATLAS_AZURE=force;
// disable entirely with ATLAS_AZURE=0.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { AUDIT } from './_paths.mjs'

const OUT = path.join(AUDIT, 'azure-resources.json')
const execFileP = promisify(execFile)
const MAX_AGE_MS = 60 * 60 * 1000

if (process.env.ATLAS_AZURE === '0') { console.log('azure-gather: disabled (ATLAS_AZURE=0)'); process.exit(0) }
if (process.env.ATLAS_AZURE !== 'force' && fs.existsSync(OUT)) {
  const age = Date.now() - fs.statSync(OUT).mtimeMs
  if (age < MAX_AGE_MS) { console.log(`azure-gather: azure-resources.json is ${Math.round(age / 60000)}min old, skipping (ATLAS_AZURE=force to refresh)`); process.exit(0) }
}

const az = async (args, { json = true } = {}) => {
  const { stdout } = await execFileP('az', [...args, ...(json ? ['--output', 'json'] : [])], { maxBuffer: 1024 * 1024 * 64, timeout: 120000 })
  return json ? JSON.parse(stdout || 'null') : stdout
}
const graph = async (q) => (await az(['graph', 'query', '-q', q, '--first', '1000'])).data

// run thunks with bounded concurrency (az CLI startup dominates, so parallelism pays off)
const pool = async (thunks, limit = 10) => {
  const results = new Array(thunks.length)
  let i = 0
  const worker = async () => { for (;;) { const n = i++; if (n >= thunks.length) return; results[n] = await thunks[n]() } }
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker))
  return results
}

// env prefixes, longest-first so 'prod' wins over 'pre' and 'demo' over 'dev'
const ENVS = ['sandbox', 'demo', 'prod', 'test', 'dev', 'poc', 'pre', 'e2e']
const parseEnvApp = (name, suffixes = ['website', 'storage']) => {
  const env = ENVS.find((e) => name.startsWith(e))
  if (!env) return null
  let rest = name.slice(env.length)
  // versioned sites: {env}{app}websitev2 -> app 'skytrackv2'
  const ver = rest.match(/website(v\d+)$/)
  const suffix = ver ? 'website' : suffixes.find((s) => rest.endsWith(s))
  if (!suffix) return null
  rest = ver ? rest.slice(0, -('website'.length + ver[1].length)) + ver[1] : rest.slice(0, -suffix.length)
  return rest ? { env, app: rest, suffix } : null
}
// infra resources carry the env infix instead: {service}-{env}-postgres-db
const ENV_RE = new RegExp(`(?:^|-)(${ENVS.join('|')})(?:-|$)`)

let account
try { account = await az(['account', 'show']) } catch {
  console.log('azure-gather: az CLI not available or not logged in — skipping (run `az login` to enable)')
  process.exit(0)
}

console.log(`azure-gather: reading tenant ${account.tenantDisplayName || account.tenantId} as ${account.user?.name}`)
const warnings = []

// ---- 1. FE apps: website storage accounts -> app x env grid -------------------------
const storage = await graph("Resources | where type == 'microsoft.storage/storageaccounts' | project name, resourceGroup, location, tags")
const apps = {}
const appEnv = (app, env) => ((apps[app] = apps[app] || { envs: {} }).envs[env] = apps[app].envs[env] || {})
for (const s of storage) {
  const p = parseEnvApp(s.name, ['website'])
  if (p) appEnv(p.app, p.env).storage = s.name
}

// ---- 2. Front Door: custom domains per app x env ------------------------------------
// Routes are named like the storage accounts ({env}{app}website) and reference the
// custom-domain resources, so profile domain maps + per-endpoint route lists give us
// the authoritative app+env -> public URL mapping.
const profiles = await graph("Resources | where type == 'microsoft.cdn/profiles' | project name, resourceGroup")
const endpoints = await graph("Resources | where type == 'microsoft.cdn/profiles/afdendpoints' | project name, id, hostName=tostring(properties.hostName)")
const domainHost = {} // custom-domain resource id (lowercase) -> hostname
await pool(profiles.map((p) => async () => {
  try {
    const domains = await az(['afd', 'custom-domain', 'list', '--profile-name', p.name, '--resource-group', p.resourceGroup])
    for (const d of domains) domainHost[d.id.toLowerCase()] = d.hostName
  } catch (e) { warnings.push(`custom-domain list failed for ${p.name}: ${String(e.message).slice(0, 120)}`) }
}))
const epLoc = (id) => { const m = id.match(/resourcegroups\/([^/]+)\/providers\/microsoft\.cdn\/profiles\/([^/]+)\//i); return m ? { rg: m[1], profile: m[2] } : null }
await pool(endpoints.map((ep) => async () => {
  const loc = epLoc(ep.id)
  if (!loc) return
  let routes
  try { routes = await az(['afd', 'route', 'list', '--profile-name', loc.profile, '--resource-group', loc.rg, '--endpoint-name', ep.name]) } catch { return }
  for (const r of routes) {
    const p = parseEnvApp(r.name, ['website'])
    if (!p) continue
    const hosts = (r.customDomains || []).map((d) => domainHost[d.id.toLowerCase()]).filter(Boolean)
      .filter((h) => !h.startsWith('www.') && !h.startsWith('old-'))
    const slot = appEnv(p.app, p.env)
    slot.domains = [...new Set([...(slot.domains || []), ...hosts])]
    slot.endpointHost = slot.endpointHost || ep.hostName
    // path-routed micro-frontends (e.g. billing -> app.example.com/modules/billing/*):
    // record the path so the app isn't mistaken for the whole domain
    const patterns = r.patternsToMatch || []
    if (!patterns.some((x) => x === '/*' || x === '/')) {
      const pp = patterns.find((x) => x !== '/' && x !== '/*')
      if (pp) slot.path = pp.replace(/\/\*$/, '')
    }
  }
}))

// ---- 3. FE deploy freshness: $web/index.html last-modified --------------------------
const webAccounts = Object.entries(apps).flatMap(([app, a]) => Object.entries(a.envs).filter(([, e]) => e.storage).map(([env, e]) => ({ app, env, account: e.storage })))
let blobDenied = 0
await pool(webAccounts.map(({ app, env, account: acct }) => async () => {
  try {
    const b = await az(['storage', 'blob', 'show', '--account-name', acct, '--container-name', '$web', '--name', 'index.html', '--auth-mode', 'login'])
    apps[app].envs[env].deployed = b?.properties?.lastModified || null
  } catch { blobDenied++ }
}))
if (blobDenied) warnings.push(`$web/index.html not readable for ${blobDenied}/${webAccounts.length} website accounts (404 or no Storage Blob Data Reader role)`)

// ---- 4. BE deploy freshness: last push per ACR repository ---------------------------
const registries = await graph("Resources | where type == 'microsoft.containerregistry/registries' | project name, resourceGroup")
const acr = {}
for (const reg of registries) {
  let repos
  try { repos = await az(['acr', 'repository', 'list', '--name', reg.name]) } catch { warnings.push(`ACR ${reg.name}: no data-plane access`); continue }
  acr[reg.name] = {}
  await pool(repos.map((repo) => async () => {
    try {
      const meta = await az(['acr', 'repository', 'show', '--name', reg.name, '--repository', repo])
      acr[reg.name][repo] = { lastPush: meta.lastUpdateTime || null }
    } catch { acr[reg.name][repo] = { lastPush: null } }
  }))
}

// ---- 5. Infra resources, parsed into service + env ----------------------------------
const INFRA_TYPES = [
  'microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbformysql/flexibleservers',
  'microsoft.sql/servers/databases', 'microsoft.documentdb/databaseaccounts',
  'microsoft.eventhub/namespaces', 'microsoft.servicebus/namespaces',
  'microsoft.app/containerapps', 'microsoft.web/sites', 'microsoft.streamanalytics/streamingjobs',
  'microsoft.containerregistry/registries', 'microsoft.cognitiveservices/accounts', 'microsoft.search/searchservices',
]
const infraRaw = await graph(`Resources | where type in ('${INFRA_TYPES.join("','")}') | project name, type, resourceGroup, location`)
const infra = infraRaw.map((r) => {
  const m = r.name.match(ENV_RE)
  const env = m ? m[1] : (r.resourceGroup.match(ENV_RE)?.[1] ?? null)
  // service guess = name up to the env token (postgres: {service}-{env}-postgres-db)
  const service = m && r.name.indexOf(`-${m[1]}`) > 0 ? r.name.slice(0, r.name.indexOf(`-${m[1]}`)) : null
  return { name: r.name, type: r.type, resourceGroup: r.resourceGroup, location: r.location, env, service }
})

const out = {
  generatedAt: new Date().toISOString(),
  subscription: { id: account.id, name: account.name, tenant: account.tenantDisplayName || account.tenantId },
  apps,            // {app}: { envs: {env}: { storage, domains[], endpointHost, deployed } }
  acr,             // {registry}: {repo}: { lastPush }
  infra,           // [{ name, type, resourceGroup, location, env, service }]
  warnings,
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
const nApps = Object.keys(apps).length
const nAcr = Object.values(acr).reduce((s, r) => s + Object.keys(r).length, 0)
console.log(`wrote azure-resources.json; apps: ${nApps}, acr repos: ${nAcr}, infra: ${infra.length}, warnings: ${warnings.length}`)
