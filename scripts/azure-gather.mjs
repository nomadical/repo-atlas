// Azure inventory gather (read-only): makes the map reflect what is actually deployed.
//
// Uses the az CLI (the operator's portal-Reader access) to collect:
//   1. FE apps per environment: storage accounts named {env}{app}website, and Azure Front Door
//      routes (named the same way) -> real custom domains per app and env
//   2. FE deploy freshness: $web/index.html last-modified per website storage account
//   3. BE deploy freshness: last image push per container-registry repository
//   4. Infra resources (Postgres/SQL/Cosmos/Event Hubs/...) parsed into service and env
//
// If az is missing or not logged in, the step is skipped and any existing azure-resources.json is
// left as-is. Skipped when the file is under an hour old unless ATLAS_AZURE=force; ATLAS_AZURE=0
// disables it.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { AUDIT } from './_paths.mjs'

const OUT = path.join(AUDIT, 'azure-resources.json')
const execFileAsync = promisify(execFile)
const MAX_AGE_MS = 60 * 60 * 1000
const MS_PER_MINUTE = 60000
const AZ_MAX_BUFFER = 1024 * 1024 * 64
const AZ_TIMEOUT_MS = 120000
const GRAPH_PAGE_SIZE = '1000'
// az CLI startup dominates each call, so parallelism pays off.
const AZ_CONCURRENCY = 10
const ERROR_SNIPPET_LENGTH = 120

// Longest first, so 'prod' wins over 'pre' and 'demo' over 'dev'.
const ENVS = ['sandbox', 'demo', 'prod', 'test', 'dev', 'poc', 'pre', 'e2e']
// Infra resources carry the env as an infix instead: {service}-{env}-postgres-db.
const ENV_INFIX_PATTERN = new RegExp(`(?:^|-)(${ENVS.join('|')})(?:-|$)`)
const WEBSITE_SUFFIX = 'website'

const INFRA_TYPES = [
  'microsoft.dbforpostgresql/flexibleservers',
  'microsoft.dbformysql/flexibleservers',
  'microsoft.sql/servers/databases',
  'microsoft.documentdb/databaseaccounts',
  'microsoft.eventhub/namespaces',
  'microsoft.servicebus/namespaces',
  'microsoft.app/containerapps',
  'microsoft.web/sites',
  'microsoft.streamanalytics/streamingjobs',
  'microsoft.containerregistry/registries',
  'microsoft.cognitiveservices/accounts',
  'microsoft.search/searchservices',
]

const exitIfDisabledOrFresh = () => {
  if (process.env.ATLAS_AZURE === '0') {
    console.log('azure-gather: disabled (ATLAS_AZURE=0)')
    process.exit(0)
  }
  if (process.env.ATLAS_AZURE === 'force' || !fs.existsSync(OUT)) return
  const ageMs = Date.now() - fs.statSync(OUT).mtimeMs
  if (ageMs >= MAX_AGE_MS) return
  console.log(
    `azure-gather: azure-resources.json is ${Math.round(ageMs / MS_PER_MINUTE)}min old, skipping (ATLAS_AZURE=force to refresh)`,
  )
  process.exit(0)
}

exitIfDisabledOrFresh()

const az = async (args, { json = true } = {}) => {
  const outputArgs = json ? ['--output', 'json'] : []
  const { stdout } = await execFileAsync('az', [...args, ...outputArgs], {
    maxBuffer: AZ_MAX_BUFFER,
    timeout: AZ_TIMEOUT_MS,
  })
  return json ? JSON.parse(stdout || 'null') : stdout
}

const graphQuery = async (query) =>
  (await az(['graph', 'query', '-q', query, '--first', GRAPH_PAGE_SIZE])).data

// Runs the thunks with bounded concurrency; results keep the thunks' order.
const runPooled = async (thunks, limit = AZ_CONCURRENCY) => {
  const results = Array.from({ length: thunks.length })
  let nextIndex = 0
  const worker = async () => {
    for (;;) {
      const index = nextIndex++
      if (index >= thunks.length) return
      results[index] = await thunks[index]()
    }
  }
  const workerCount = Math.min(limit, thunks.length)
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

// Versioned sites keep the version on the app: {env}{app}websitev2 -> app '{app}v2'.
const parseEnvApp = (name, suffixes = [WEBSITE_SUFFIX, 'storage']) => {
  const env = ENVS.find((candidate) => name.startsWith(candidate))
  if (!env) return null
  const rest = name.slice(env.length)
  const versionMatch = rest.match(/website(v\d+)$/)
  if (versionMatch) {
    const version = versionMatch[1]
    const app = rest.slice(0, -(WEBSITE_SUFFIX.length + version.length)) + version
    return app ? { env, app, suffix: WEBSITE_SUFFIX } : null
  }
  const suffix = suffixes.find((candidate) => rest.endsWith(candidate))
  if (!suffix) return null
  const app = rest.slice(0, -suffix.length)
  return app ? { env, app, suffix } : null
}

const readAccount = async () => {
  try {
    return await az(['account', 'show'])
  } catch {
    console.log('azure-gather: az CLI not available or not logged in — skipping (run `az login` to enable)')
    process.exit(0)
  }
}

const account = await readAccount()

console.log(
  `azure-gather: reading tenant ${account.tenantDisplayName || account.tenantId} as ${account.user?.name}`,
)
const warnings = []

// ---- 1. FE apps: website storage accounts -> app x env grid ----------------------------------
// {app}: { envs: {env}: { storage, domains[], endpointHost, path, deployed } }
const apps = {}

const envSlot = (app, env) => {
  if (!apps[app]) apps[app] = { envs: {} }
  const envs = apps[app].envs
  if (!envs[env]) envs[env] = {}
  return envs[env]
}

const storageAccounts = await graphQuery(
  "Resources | where type == 'microsoft.storage/storageaccounts' | project name, resourceGroup, location, tags",
)
for (const storageAccount of storageAccounts) {
  const parsed = parseEnvApp(storageAccount.name, [WEBSITE_SUFFIX])
  if (parsed) envSlot(parsed.app, parsed.env).storage = storageAccount.name
}

// ---- 2. Front Door: custom domains per app x env ---------------------------------------------
// Routes are named like the storage accounts and reference custom-domain resources, so the
// profiles' domain lists plus each endpoint's routes give the authoritative app+env -> URL mapping.
const profiles = await graphQuery(
  "Resources | where type == 'microsoft.cdn/profiles' | project name, resourceGroup",
)
const frontDoorEndpoints = await graphQuery(
  "Resources | where type == 'microsoft.cdn/profiles/afdendpoints' | project name, id, hostName=tostring(properties.hostName)",
)

const hostByDomainId = new Map() // lowercased custom-domain resource id -> hostname

const loadProfileDomains = async (profile) => {
  try {
    const domains = await az([
      'afd',
      'custom-domain',
      'list',
      '--profile-name',
      profile.name,
      '--resource-group',
      profile.resourceGroup,
    ])
    for (const domain of domains) hostByDomainId.set(domain.id.toLowerCase(), domain.hostName)
  } catch (error) {
    warnings.push(
      `custom-domain list failed for ${profile.name}: ${String(error.message).slice(0, ERROR_SNIPPET_LENGTH)}`,
    )
  }
}

await runPooled(profiles.map((profile) => () => loadProfileDomains(profile)))

const endpointLocation = (endpointId) => {
  const match = endpointId.match(/resourcegroups\/([^/]+)\/providers\/microsoft\.cdn\/profiles\/([^/]+)\//i)
  return match ? { resourceGroup: match[1], profile: match[2] } : null
}

// www. and old- hosts are redirects, not where the app lives.
const isPrimaryHost = (host) => !host.startsWith('www.') && !host.startsWith('old-')

const isCatchAllPattern = (pattern) => pattern === '/*' || pattern === '/'

const applyRoute = (route, endpointHost) => {
  const parsed = parseEnvApp(route.name, [WEBSITE_SUFFIX])
  if (!parsed) return
  const hosts = (route.customDomains || [])
    .map((domain) => hostByDomainId.get(domain.id.toLowerCase()))
    .filter(Boolean)
    .filter(isPrimaryHost)
  const slot = envSlot(parsed.app, parsed.env)
  slot.domains = [...new Set([...(slot.domains || []), ...hosts])]
  slot.endpointHost = slot.endpointHost || endpointHost
  // Path-routed micro-frontends (billing -> app.example.com/modules/billing/*) record their path so
  // the app isn't mistaken for the whole domain.
  const patterns = route.patternsToMatch || []
  if (patterns.some(isCatchAllPattern)) return
  const appPattern = patterns.find((pattern) => !isCatchAllPattern(pattern))
  if (appPattern) slot.path = appPattern.replace(/\/\*$/, '')
}

const loadEndpointRoutes = async (endpoint) => {
  const location = endpointLocation(endpoint.id)
  if (!location) return
  let routes
  try {
    routes = await az([
      'afd',
      'route',
      'list',
      '--profile-name',
      location.profile,
      '--resource-group',
      location.resourceGroup,
      '--endpoint-name',
      endpoint.name,
    ])
  } catch {
    return
  }
  for (const route of routes) applyRoute(route, endpoint.hostName)
}

await runPooled(frontDoorEndpoints.map((endpoint) => () => loadEndpointRoutes(endpoint)))

// ---- 3. FE deploy freshness: $web/index.html last-modified -----------------------------------
const websiteAccounts = Object.entries(apps).flatMap(([app, { envs }]) =>
  Object.entries(envs)
    .filter(([, slot]) => slot.storage)
    .map(([env, slot]) => ({ app, env, storageAccount: slot.storage })),
)
let unreadableIndexCount = 0

const loadDeployTime = async ({ app, env, storageAccount }) => {
  try {
    const indexBlob = await az([
      'storage',
      'blob',
      'show',
      '--account-name',
      storageAccount,
      '--container-name',
      '$web',
      '--name',
      'index.html',
      '--auth-mode',
      'login',
    ])
    apps[app].envs[env].deployed = indexBlob?.properties?.lastModified || null
  } catch {
    unreadableIndexCount++
  }
}

await runPooled(websiteAccounts.map((websiteAccount) => () => loadDeployTime(websiteAccount)))
if (unreadableIndexCount) {
  warnings.push(
    `$web/index.html not readable for ${unreadableIndexCount}/${websiteAccounts.length} website accounts (404 or no Storage Blob Data Reader role)`,
  )
}

// ---- 4. BE deploy freshness: last push per ACR repository ------------------------------------
// {registry}: {repo}: { lastPush }
const acr = {}

const loadLastPushes = async (registryName) => {
  let repositories
  try {
    repositories = await az(['acr', 'repository', 'list', '--name', registryName])
  } catch {
    warnings.push(`ACR ${registryName}: no data-plane access`)
    return
  }
  const lastPushByRepo = {}
  acr[registryName] = lastPushByRepo
  const loadRepository = async (repository) => {
    try {
      const meta = await az(['acr', 'repository', 'show', '--name', registryName, '--repository', repository])
      lastPushByRepo[repository] = { lastPush: meta.lastUpdateTime || null }
    } catch {
      lastPushByRepo[repository] = { lastPush: null }
    }
  }
  await runPooled(repositories.map((repository) => () => loadRepository(repository)))
}

const registries = await graphQuery(
  "Resources | where type == 'microsoft.containerregistry/registries' | project name, resourceGroup",
)
// One registry at a time; each already runs its repositories in parallel.
for (const registry of registries) await loadLastPushes(registry.name)

// ---- 5. Infra resources, parsed into service + env -------------------------------------------
// The service guess is the name up to the env token ({service}-{env}-postgres-db).
const parseInfraResource = (resource) => {
  const nameEnvMatch = resource.name.match(ENV_INFIX_PATTERN)
  const env = nameEnvMatch ? nameEnvMatch[1] : (resource.resourceGroup.match(ENV_INFIX_PATTERN)?.[1] ?? null)
  const envTokenIndex = nameEnvMatch ? resource.name.indexOf(`-${nameEnvMatch[1]}`) : -1
  const service = envTokenIndex > 0 ? resource.name.slice(0, envTokenIndex) : null
  return {
    name: resource.name,
    type: resource.type,
    resourceGroup: resource.resourceGroup,
    location: resource.location,
    env,
    service,
  }
}

const infraResources = await graphQuery(
  `Resources | where type in ('${INFRA_TYPES.join("','")}') | project name, type, resourceGroup, location`,
)
const infra = infraResources.map(parseInfraResource)

const output = {
  generatedAt: new Date().toISOString(),
  subscription: { id: account.id, name: account.name, tenant: account.tenantDisplayName || account.tenantId },
  apps,
  acr,
  infra,
  warnings,
}
fs.writeFileSync(OUT, JSON.stringify(output, null, 2))
const appCount = Object.keys(apps).length
const acrRepoCount = Object.values(acr).reduce(
  (sum, repositories) => sum + Object.keys(repositories).length,
  0,
)
console.log(
  `wrote azure-resources.json; apps: ${appCount}, acr repos: ${acrRepoCount}, infra: ${infra.length}, warnings: ${warnings.length}`,
)
