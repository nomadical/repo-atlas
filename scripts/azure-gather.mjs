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
import { runPooled } from './lib/run-pooled.mjs'

const OUT = path.join(AUDIT, 'azure-resources.json')
const execFileAsync = promisify(execFile)
const MAX_AGE_MS = 60 * 60 * 1000
const MS_PER_MINUTE = 60000
const AZ_MAX_BUFFER = 1024 * 1024 * 64
const AZ_TIMEOUT_MS = 120000
const GRAPH_PAGE_SIZE = '1000'
// az CLI startup dominates each call, so parallelism pays off. Pooled calls only fetch; their
// results are applied afterwards in input order, so the output doesn't depend on which finished first.
const AZ_CONCURRENCY = 10
const ERROR_SNIPPET_LENGTH = 120

// Longest first, so 'prod' wins over 'pre' and 'demo' over 'dev'.
const ENVS = ['sandbox', 'demo', 'prod', 'test', 'dev', 'poc', 'pre', 'e2e']
// Infra resources carry the env as an infix instead: {service}-{env}-postgres-db.
const ENV_INFIX_PATTERN = new RegExp(`(?:^|-)(${ENVS.join('|')})(?:-|$)`)

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

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const compareResources = (a, b) =>
  compareText(a.name, b.name) ||
  compareText(a.resourceGroup ?? '', b.resourceGroup ?? '') ||
  compareText(a.id ?? '', b.id ?? '')

// Resource Graph doesn't promise a row order, so rows are sorted to keep reruns identical.
const graphQuery = async (query) =>
  (await az(['graph', 'query', '-q', query, '--first', GRAPH_PAGE_SIZE])).data.sort(compareResources)

const fetchPooled = (items, fetch) =>
  runPooled(
    items.map((item) => () => fetch(item)),
    AZ_CONCURRENCY,
  )

// {env}{app}website -> { env, app }. Versioned sites keep the version on the app:
// {env}{app}websitev2 -> app '{app}v2'.
const WEBSITE_NAME = /^(.*)website(v\d+)?$/

const parseEnvApp = (name) => {
  const env = ENVS.find((candidate) => name.startsWith(candidate))
  if (!env) return null
  const websiteMatch = name.slice(env.length).match(WEBSITE_NAME)
  if (!websiteMatch) return null
  const [, base, version = ''] = websiteMatch
  const app = base + version
  return app ? { env, app } : null
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
  const parsed = parseEnvApp(storageAccount.name)
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

const listProfileDomains = async (profile) => {
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
    return { domains }
  } catch (error) {
    return { domains: [], error }
  }
}

const domainListings = await fetchPooled(profiles, listProfileDomains)
for (const [index, { domains, error }] of domainListings.entries()) {
  if (error) {
    const reason = String(error.message).slice(0, ERROR_SNIPPET_LENGTH)
    warnings.push(`custom-domain list failed for ${profiles[index].name}: ${reason}`)
  }
  for (const domain of domains) hostByDomainId.set(domain.id.toLowerCase(), domain.hostName)
}

const endpointLocation = (endpointId) => {
  const match = endpointId.match(/resourcegroups\/([^/]+)\/providers\/microsoft\.cdn\/profiles\/([^/]+)\//i)
  return match ? { resourceGroup: match[1], profile: match[2] } : null
}

// www. and old- hosts are redirects, not where the app lives.
const isPrimaryHost = (host) => !host.startsWith('www.') && !host.startsWith('old-')

const isCatchAllPattern = (pattern) => pattern === '/*' || pattern === '/'

const applyRoute = (route, endpointHost) => {
  const parsed = parseEnvApp(route.name)
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

const listEndpointRoutes = async (endpoint) => {
  const location = endpointLocation(endpoint.id)
  if (!location) return []
  try {
    return await az([
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
    return []
  }
}

const routesByEndpoint = await fetchPooled(frontDoorEndpoints, listEndpointRoutes)
for (const [index, endpoint] of frontDoorEndpoints.entries()) {
  for (const route of routesByEndpoint[index]) applyRoute(route, endpoint.hostName)
}

// ---- 3. FE deploy freshness: $web/index.html last-modified -----------------------------------
const websiteAccounts = Object.entries(apps).flatMap(([app, { envs }]) =>
  Object.entries(envs)
    .filter(([, slot]) => slot.storage)
    .map(([env, slot]) => ({ app, env, storageAccount: slot.storage })),
)

// Undefined when index.html can't be read.
const deployTimeOf = async ({ storageAccount }) => {
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
    return indexBlob?.properties?.lastModified || null
  } catch {
    return undefined
  }
}

const deployTimes = await fetchPooled(websiteAccounts, deployTimeOf)
let unreadableIndexCount = 0
for (const [index, { app, env }] of websiteAccounts.entries()) {
  if (deployTimes[index] === undefined) unreadableIndexCount++
  else apps[app].envs[env].deployed = deployTimes[index]
}
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
  const lastPushOf = async (repository) => {
    try {
      const meta = await az(['acr', 'repository', 'show', '--name', registryName, '--repository', repository])
      return meta.lastUpdateTime || null
    } catch {
      return null
    }
  }
  const lastPushes = await fetchPooled(repositories, lastPushOf)
  acr[registryName] = Object.fromEntries(
    repositories.map((repository, index) => [repository, { lastPush: lastPushes[index] }]),
  )
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
