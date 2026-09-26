import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { ROOT, AUDIT, maybeFetch } from './_paths.mjs'
import { repos } from './repos.mjs'
import {
  extractEndpointsFromText,
  extractTemplateEndpointsFromText,
  extractUrlEndpointsFromText,
} from './lib/endpoints.mjs'

const RG_MAX_BUFFER = 1024 * 1024 * 64
const MAX_URL_FALLBACK_ENDPOINTS = 24
const SPEC_FETCH_TIMEOUT_MS = 8000
// {env} placeholder in curated hosts; dev is the environment we probe and link to.
const DEFAULT_ENV = 'dev'
const QUIET_STDIO = ['ignore', 'pipe', 'ignore']

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const configArray = (value) => (Array.isArray(value) ? value : [])

// ---- Curated config ---------------------------------------------------------------------------
// repo-extra.json holds curated per-repo knowledge (hosts, non-npm SaaS, ...). Missing file means
// an empty overlay.
const repoExtra = readJson(path.join(AUDIT, 'repo-extra.json')) || {}
const appConfig = readJson(path.join(AUDIT, 'config.json')) || {}

// npm scopes your org publishes under. Include scopes you've migrated away from: older pins in
// un-updated repos still reference them, and that drift is worth seeing.
const INTERNAL_SCOPES = configArray(appConfig.internalScopes).map((scope) =>
  scope.endsWith('/') ? scope : `${scope}/`,
)
// Unscoped, pre-migration names of first-party packages.
const LEGACY_PACKAGES = configArray(appConfig.legacyPackages)

// Your own API domains as an rg alternation. Each is a literal domain suffix, so "example.com"
// matches api.example.com but not notexample.com. The doubled backslash survives the shell's
// double quotes.
const API_DOMAIN_ALTERNATION =
  configArray(appConfig.apiDomains)
    .map((domain) => domain.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&'))
    .join('|') || null

// Built-in npm -> SaaS mappings (stable, not org-specific), extended by repo-extra.json
// `saasPatterns` ([regexSource, label] pairs).
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
  ...(repoExtra.saasPatterns || []).map(([source, label]) => [new RegExp(source), label]),
]
// SaaS a repo uses that isn't an npm dep, and detected deps the team says aren't actually used.
const CURATED_EXTERNALS = repoExtra.externals?.curated || {}
const EXCLUDED_EXTERNALS = repoExtra.externals?.exclude || {}

// Repo custom properties from the committed github-meta.json (refreshed by
// github-inventory.mjs on every regenerate), so a just-set property takes effect on the next run.
const readGithubProps = () => {
  const meta = readJson(path.join(AUDIT, 'github-meta.json'))
  const propsByRepo = new Map()
  for (const [name, repo] of Object.entries(meta?.repos || {})) {
    if (repo.props) propsByRepo.set(name, repo.props)
  }
  return propsByRepo
}
const githubPropsByRepo = readGithubProps()

// ---- package.json ------------------------------------------------------------------------------
const mergedDeps = (packageJson, buckets) =>
  Object.assign({}, ...buckets.map((bucket) => packageJson?.[bucket] || {}))

const DEP_BUCKETS = [
  ['dependencies', false],
  ['peerDependencies', false],
  ['devDependencies', true],
]

const isInternalPackage = (name) => INTERNAL_SCOPES.some((scope) => name.startsWith(scope))

const collectInternalDeps = (packageJson) => {
  const internalDeps = []
  for (const [bucket, dev] of DEP_BUCKETS) {
    for (const [name, version] of Object.entries(packageJson?.[bucket] || {})) {
      if (isInternalPackage(name)) internalDeps.push({ name, version, dev, bucket })
    }
  }
  return internalDeps
}

// A repo still on a bare legacy name hasn't moved onto the scoped package yet.
const detectLegacyPackages = (packageJson) => {
  const allDeps = mergedDeps(packageJson, ['dependencies', 'devDependencies', 'peerDependencies'])
  return LEGACY_PACKAGES.some((name) => Object.prototype.hasOwnProperty.call(allDeps, name))
}

const installedVersion = (repoDir, pkg) => {
  const installed = readJson(path.join(repoDir, 'node_modules', ...pkg.split('/'), 'package.json'))
  return installed?.version || null
}

const detectNode = (repoDir, packageJson) => {
  const nvmrc = path.join(repoDir, '.nvmrc')
  if (fs.existsSync(nvmrc)) return { source: '.nvmrc', value: fs.readFileSync(nvmrc, 'utf8').trim() }
  if (packageJson?.volta?.node) return { source: 'volta', value: packageJson.volta.node }
  if (packageJson?.engines?.node) return { source: 'engines', value: packageJson.engines.node }
  return { source: null, value: null }
}

const storybookPackage = (allDeps) => {
  if (allDeps['@storybook/react-vite']) return '@storybook/react-vite'
  if (allDeps['storybook']) return 'storybook'
  return null
}

const tooling = (repoDir, packageJson) => {
  const allDeps = mergedDeps(packageJson, ['dependencies', 'devDependencies', 'peerDependencies'])
  const versions = (pkg) => ({ declared: allDeps[pkg] ?? null, resolved: installedVersion(repoDir, pkg) })
  const storybook = storybookPackage(allDeps)
  return {
    react: versions('react'),
    vite: versions('vite'),
    typescript: versions('typescript'),
    mui: versions('@mui/material'),
    storybook: storybook
      ? { pkg: storybook, ...versions(storybook) }
      : { pkg: null, declared: null, resolved: null },
    node: detectNode(repoDir, packageJson),
  }
}

const SPEC_FILE_CANDIDATES = [
  'orval.config.ts',
  'orval.config.js',
  'orval.config.cjs',
  'orval.config.mjs',
  'openapi.yaml',
  'openapi.yml',
  'openapi.json',
  'swagger.yaml',
  'swagger.yml',
  'swagger.json',
]
const CLIENT_FOLDER_CANDIDATES = ['src/api', 'src/generated', 'api', 'src/services/api', 'generated']

const feToBeHeuristics = (repoDir, packageJson) => {
  const allDeps = mergedDeps(packageJson, ['dependencies', 'devDependencies'])
  const signals = {
    orval: !!allDeps['orval'],
    openapiTypescript: !!allDeps['openapi-typescript'],
    openapiGenerator: !!(allDeps['@openapitools/openapi-generator-cli'] || allDeps['openapi-generator']),
    axios: !!allDeps['axios'],
  }
  const existsInRepo = (relativePath) => fs.existsSync(path.join(repoDir, relativePath))
  const found = { specFiles: [], clientFolders: [], orvalConfig: null }
  for (const candidate of SPEC_FILE_CANDIDATES) {
    if (!existsInRepo(candidate)) continue
    found.specFiles.push(candidate)
    if (candidate.startsWith('orval')) found.orvalConfig = candidate
  }
  found.clientFolders.push(...CLIENT_FOLDER_CANDIDATES.filter(existsInRepo))
  return { signals, found }
}

const detectExternals = (packageJson, folder) => {
  const deps = mergedDeps(packageJson, ['dependencies', 'devDependencies'])
  const viaByLabel = new Map()
  for (const name of Object.keys(deps)) {
    for (const [pattern, label] of SAAS_BY_DEP) {
      if (pattern.test(name)) viaByLabel.set(label, 'dep:' + name)
    }
  }
  for (const label of CURATED_EXTERNALS[folder] || []) {
    if (!viaByLabel.has(label)) viaByLabel.set(label, 'curated')
  }
  for (const label of EXCLUDED_EXTERNALS[folder] || []) viaByLabel.delete(label)
  return [...viaByLabel].map(([name, via]) => ({ name, via }))
}

// ---- git -------------------------------------------------------------------------------------
const gitOutput = (repoDir, command) => {
  try {
    return execSync(command, { cwd: repoDir, stdio: QUIET_STDIO }).toString().trim()
  } catch {
    return null
  }
}

const originHeadRef = (repoDir) => gitOutput(repoDir, 'git symbolic-ref refs/remotes/origin/HEAD')

const defaultBranch = (repoDir) => {
  const originHead = originHeadRef(repoDir)
  if (originHead !== null) return originHead.replace('refs/remotes/origin/', '')
  return gitOutput(repoDir, 'git rev-parse --abbrev-ref HEAD')
}

// Uses the remote default branch, not local HEAD: a local checkout is often behind origin (or
// parked on an old branch), which made active repos look months stale.
const lastCommitDate = (repoDir) => {
  const commitDateAt = (ref) => gitOutput(repoDir, `git log -1 --format=%cI ${ref}`)
  const remoteBranch = originHeadRef(repoDir)?.replace('refs/remotes/', '')
  return (remoteBranch && commitDateAt(remoteBranch)) || commitDateAt('origin/HEAD') || commitDateAt('HEAD')
}

const listWorkflowSizes = (repoDir) => {
  const dir = path.join(repoDir, '.github', 'workflows')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => ({ file, len: fs.readFileSync(path.join(dir, file), 'utf8').length }))
}

// ---- Hosts -----------------------------------------------------------------------------------
// Owner-set repo custom properties win; repo-extra.json `hosts` is the per-field fallback.
// Host values may contain an {env} placeholder.
const HOST_PROPERTIES = [
  ['live', 'live-url'],
  ['api', 'api-url'],
  ['swagger', 'swagger-url'],
]
const overriddenHosts = []

const hostsFor = (folder) => {
  const fallback = repoExtra.hosts?.[folder] || {}
  const props = githubPropsByRepo.get(folder) || {}
  const hosts = {}
  for (const [field, property] of HOST_PROPERTIES) {
    hosts[field] = props[property] ?? fallback[field] ?? null
    if (props[property] != null && fallback[field] != null && props[property] !== fallback[field]) {
      overriddenHosts.push(`${folder}.${field}: property "${property}" overrides repo-extra`)
    }
  }
  return hosts
}

const swaggerUrl = (hosts) => {
  if (hosts.swagger) return hosts.swagger
  // Quarkus default Swagger UI path.
  if (hosts.api) return `https://${hosts.api.replace('{env}', DEFAULT_ENV)}/q/swagger-ui/`
  return null
}

// ---- Endpoints -------------------------------------------------------------------------------
// rg exits non-zero when nothing matches; its stdout is still the (empty) result.
const runRipgrep = (command) => {
  try {
    return execSync(command, { encoding: 'utf8', maxBuffer: RG_MAX_BUFFER })
  } catch (error) {
    return error.stdout ? error.stdout.toString() : ''
  }
}

const HOOK_CALL_PATTERN = 'use[A-Za-z]+Endpoints\\([^)]{0,200}'
const API_TEMPLATE_PATTERN =
  '\\$\\{[A-Za-z0-9_]*(URL|Url|API|Api|BASE|Base|HOST|Host|ENDPOINT|Endpoint)[A-Za-z0-9_]*\\}'
// Story fixtures (`${DEFAULT_URL}/first`, `gateway/22222/...`) must not leak in as endpoints.
const NON_APP_FILE_GLOBS = "-g '!*.stories.*' -g '!*.test.*' -g '!*.spec.*' -g '!*.cy.*' -g '!*.mdx'"

// Merges two structured sources: literal use*Endpoints('path') hook args and `${apiUrl}/path`
// templates in the hook definition. A repo can use both, so the template pass always runs. Only
// apps with no hook literal fall back to grepped backend URLs.
const extractEndpoints = (repoDir) => {
  const src = path.join(repoDir, 'src')
  if (!fs.existsSync(src)) return []
  const matchesOnly = (pattern, flags = '') =>
    runRipgrep(`rg -oIN ${flags} --no-filename -g '!node_modules' "${pattern}" '${src}'`)
  // Single-quoted so the shell leaves ${...} untouched.
  const wholeLines = (pattern) =>
    runRipgrep(`rg -IN --no-filename -g '!node_modules' ${NON_APP_FILE_GLOBS} '${pattern}' '${src}'`)

  const endpoints = extractEndpointsFromText(matchesOnly(HOOK_CALL_PATTERN, '-U'))
  const hadHookLiteral = endpoints.size > 0
  extractTemplateEndpointsFromText(wholeLines(API_TEMPLATE_PATTERN), endpoints)

  // Structured endpoints are trusted: uncapped, no URL fallback.
  if (hadHookLiteral) return [...endpoints].sort()
  // Without configured API domains a CDN or docs link would read as an endpoint, so skip the fallback.
  if (!API_DOMAIN_ALTERNATION) return [...endpoints].sort()
  const urlMatches = matchesOnly(`https?://[A-Za-z0-9._-]+\\.(${API_DOMAIN_ALTERNATION})[A-Za-z0-9./_-]*`)
  extractUrlEndpointsFromText(urlMatches, endpoints)
  return [...endpoints].sort().slice(0, MAX_URL_FALLBACK_ENDPOINTS)
}

// ---- Gather ----------------------------------------------------------------------------------
const gatherRepo = (folder) => {
  const repoDir = path.join(ROOT, folder)
  maybeFetch(repoDir)
  const packageJson = readJson(path.join(repoDir, 'package.json'))
  const externals = detectExternals(packageJson, folder)
  const endpoints = extractEndpoints(repoDir)
  const hosts = hostsFor(folder)
  return {
    folder,
    externals,
    endpoints,
    liveUrl: hosts.live,
    apiUrl: hosts.api,
    swagger: swaggerUrl(hosts),
    name: packageJson?.name ?? null,
    version: packageJson?.version ?? null,
    defaultBranch: defaultBranch(repoDir),
    lastCommitDate: lastCommitDate(repoDir),
    internalDeps: collectInternalDeps(packageJson),
    legacyPackages: detectLegacyPackages(packageJson),
    tooling: tooling(repoDir, packageJson),
    workflows: listWorkflowSizes(repoDir),
    feToBe: feToBeHeuristics(repoDir, packageJson),
    scripts: packageJson?.scripts ?? {},
    deps_count: Object.keys(packageJson?.dependencies || {}).length,
  }
}

const gathered = repos.all.map(gatherRepo)

// ---- Swagger deep links ----------------------------------------------------------------------
// Maps each endpoint to its Swagger UI tag anchor (#/tag), from the reachable OpenAPI spec.
const fetchSpec = async (apiHost) => {
  const url = `https://${apiHost.replace('{env}', DEFAULT_ENV)}/q/openapi?format=json`
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return null
    return JSON.parse(await response.text())
  } catch {
    return null
  }
}

// Path parameters are blanked so `orders/{id}` matches `orders/{orderId}`.
const blankPathParams = (endpoint) => endpoint.replace(/\{[^}]*\}/g, '{}')

const firstTag = (pathItem) => {
  const operation = pathItem.get || Object.values(pathItem).find((candidate) => candidate && candidate.tags)
  return operation && operation.tags && operation.tags[0]
}

const tagLinksBySpecPath = (spec, swaggerBase) => {
  const links = new Map()
  for (const [specPath, pathItem] of Object.entries(spec.paths || {})) {
    // Malformed specs can have a null or scalar path item.
    if (!pathItem || typeof pathItem !== 'object') continue
    const tag = firstTag(pathItem)
    if (!tag) continue
    const key = blankPathParams(specPath.replace(/^\//, ''))
    if (!links.get(key)) links.set(key, `${swaggerBase}#/${encodeURIComponent(tag)}`)
  }
  return links
}

const addEndpointLinks = async (repo) => {
  if (!repo.apiUrl || !repo.swagger || !(repo.endpoints || []).length) return
  const spec = await fetchSpec(repo.apiUrl)
  if (!spec) return
  const tagLinks = tagLinksBySpecPath(spec, repo.swagger)
  const endpointLinks = {}
  for (const endpoint of repo.endpoints) {
    const link = tagLinks.get(blankPathParams(endpoint))
    if (link) endpointLinks[endpoint] = link
  }
  const linkCount = Object.keys(endpointLinks).length
  if (!linkCount) return
  repo.endpointLinks = endpointLinks
  console.log(`  deeplinks ${repo.folder}: ${linkCount}/${repo.endpoints.length}`)
}

await Promise.all(gathered.map(addEndpointLinks))

fs.writeFileSync(path.join(AUDIT, 'scripts/gather-out.json'), JSON.stringify(gathered, null, 2))
if (overriddenHosts.length) {
  const uniqueOverrides = [...new Set(overriddenHosts)]
  console.log(
    `  hosts from custom properties (repo-extra.json fallback now redundant): ${uniqueOverrides.join('; ')}`,
  )
}
console.log('done; repos:', gathered.length)
