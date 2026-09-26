// Backend tooling scanner: reads the cloned backend repos and extracts their stack (build tool,
// Java version, framework + version, modules) plus messaging, REST and Golden Path facts.
//
// Tooling versions live inside build.gradle / pom.xml, so unlike github-inventory.mjs this needs a
// local checkout. In CI the regenerate workflow must clone the backends alongside the frontends.
//
// Writes backend-tooling.json keyed by repo folder. Repos not on disk are listed under `missing`
// instead of failing, so a partial checkout degrades visibly.
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { AUDIT, ROOT, maybeFetch } from './_paths.mjs'
import { discoverBackendFolders } from './repos.mjs'

const MAX_WALK_DEPTH = 12
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'build', 'target', 'dist', '.gradle'])
const PATH_SEGMENTS_IN_PREFIX = 2

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const firstGroup = (regex, text) => {
  const match = text.match(regex)
  return match ? match[1] : null
}

const allGroups = (regex, text) => [...text.matchAll(regex)].map((match) => match[1])

const splitLines = (text) => text.split(/\r?\n/)

// Backend repos to scan: the auto-discovered clones plus BACKEND_REPOS (the canonical CI list,
// space-separated). Listed repos that aren't on disk end up under `missing`.
function listBackends() {
  const fromEnv = (process.env.BACKEND_REPOS || '').split(/\s+/).filter(Boolean)
  return [...new Set([...fromEnv, ...discoverBackendFolders()])].sort()
}

// ---- Git metadata ----------------------------------------------------------------------------

function runGit(dir, command) {
  try {
    return execSync(command, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function gitInfo(dir) {
  maybeFetch(dir)
  const git = (command) => runGit(dir, command)
  const branch =
    git('git rev-parse --abbrev-ref origin/HEAD')?.replace(/^origin\//, '') ||
    git('git rev-parse --abbrev-ref HEAD')
  const ref = branch ? `origin/${branch}` : 'HEAD'
  // The folder can lag a GitHub rename, and the inventory is keyed by the GitHub name.
  const remoteUrl = git('git config --get remote.origin.url') || ''
  const repoName = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/)?.[1] || null
  return {
    defaultBranch: branch,
    lastCommit: git(`git log -1 --format=%cI ${ref}`) || git('git log -1 --format=%cI'),
    repoName,
  }
}

// ---- Build stack -----------------------------------------------------------------------------

function scanGradle(dir) {
  const properties = readText(path.join(dir, 'gradle.properties'))
  const build = readText(path.join(dir, 'build.gradle')) || readText(path.join(dir, 'build.gradle.kts'))
  const settings =
    readText(path.join(dir, 'settings.gradle')) || readText(path.join(dir, 'settings.gradle.kts'))
  const quarkusVersion = firstGroup(/quarkusPlatformVersion\s*=\s*([\d.]+\w*)/i, properties)
  // Matches both Groovy (include 'x') and Kotlin DSL (include("x")).
  const isMultiModule = allGroups(/^\s*include\s*[('"]/gim, settings).length > 0
  let framework = null
  if (quarkusVersion) framework = 'Quarkus'
  else if (build.includes('spring-boot')) framework = 'Spring Boot'
  return {
    build: 'Gradle' + (isMultiModule ? ' (multi-module)' : ''),
    java:
      firstGroup(/JavaLanguageVersion\.of\((\d+)\)/i, build) ||
      firstGroup(/sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?(\d+)/i, build),
    framework,
    frameworkVersion: quarkusVersion,
    modules: allGroups(/include\s*\(?\s*['"]:?([^'"]+)['"]/gi, settings),
  }
}

function scanMaven(dir) {
  const pom = readText(path.join(dir, 'pom.xml'))
  const quarkusVersion = firstGroup(/<quarkus\.platform\.version>([^<]+)/i, pom)
  const isMultiModule = allGroups(/<module>/gi, pom).length > 0
  let framework = null
  if (quarkusVersion) framework = 'Quarkus'
  else if (/spring-boot-starter-parent/.test(pom)) framework = 'Spring Boot'
  return {
    build: 'Maven' + (isMultiModule ? ' (multi-module)' : ''),
    java: firstGroup(/<(?:maven\.compiler\.(?:source|release)|java\.version)>(\d+)/i, pom),
    framework,
    frameworkVersion: quarkusVersion,
    modules: allGroups(/<module>([^<]+)<\/module>/gi, pom),
  }
}

// ---- Source file collection ------------------------------------------------------------------

// The first path segment under the repo root, unless it is `src` (a single-module repo). All
// scanners use this so producers, consumers and providers get the same component ids.
function moduleOf(repoDir, file) {
  const firstSegment = path.relative(repoDir, file).split(path.sep)[0]
  return firstSegment === 'src' ? null : firstSegment
}

const RESOURCES_DIR = `src${path.sep}main${path.sep}resources`
const JAVA_DIR = `src${path.sep}main${path.sep}java`

// Test-only modules (integration-tests/, e2e/…) declare compile-scope H2 etc.
function isInTestModule(repoDir, dir) {
  const segments = path.relative(repoDir, dir).split(path.sep)
  return segments.some((segment) => /^(tests?|e2e|it|.*-tests?)$/i.test(segment))
}

function listDirectory(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// One walk for all scanners, so a 3000-file backend is read once. Build files are collected from
// subprojects too: a multi-module repo declares its datasource in the module, not the root.
function collectSourceFiles(repoDir) {
  const propFiles = []
  const javaFiles = []
  const buildFiles = []

  const walk = (dir, depth) => {
    if (depth > MAX_WALK_DEPTH) return
    for (const entry of listDirectory(dir)) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), depth + 1)
        continue
      }
      const file = path.join(dir, entry.name)
      if (/^application[^/]*\.properties$/.test(entry.name) && dir.includes(RESOURCES_DIR)) {
        propFiles.push(file)
      } else if (entry.name.endsWith('.java') && dir.includes(JAVA_DIR)) {
        javaFiles.push(file)
      } else if (/^(pom\.xml|build\.gradle(\.kts)?)$/.test(entry.name) && !isInTestModule(repoDir, dir)) {
        buildFiles.push(file)
      }
    }
  }

  walk(repoDir, 0)
  return { propFiles, javaFiles, buildFiles }
}

// `${var:default}` becomes its default and a bare `${prefix}` disappears, e.g. in topic names
// (`${kafka.env.prefix}skycore_logger`) and URLs (`${ASSET_URL:https://device-data-asset...}`).
const resolvePlaceholders = (value) =>
  value
    .replace(/\$\{[^:}]*:([^}]*)\}/g, '$1')
    .replace(/\$\{[^}]*\}/g, '')
    .trim()

// ---- Kafka messaging channels (MicroProfile reactive messaging) --------------------------------

const MESSAGING_LINE = /^\s*mp\.messaging\.(incoming|outgoing)\.([^.=\s]+)\.([A-Za-z0-9_.-]+)\s*=\s*(.*)$/

// The topic is the `.topic` override when set, else the channel name (the MicroProfile default).
function scanMessaging(propFiles, repoDir) {
  const channels = new Map() // "module|direction|channel" -> { module, direction, channel, topic }
  for (const file of propFiles) {
    const module = moduleOf(repoDir, file)
    for (const line of splitLines(readText(file))) {
      const match = line.match(MESSAGING_LINE)
      if (!match) continue
      const [, direction, channel, property, value] = match
      const key = `${module}|${direction}|${channel}`
      if (!channels.has(key)) channels.set(key, { module, direction, channel, topic: channel })
      const topic = resolvePlaceholders(value)
      if (property === 'topic' && topic) channels.get(key).topic = topic
    }
  }
  return [...channels.values()]
}

// ---- REST providers (JAX-RS resource roots) ----------------------------------------------------

// Annotations, comments and blank lines between an annotation and its declaration.
const ANNOTATION_BLOCK_LINE = /^\s*(@|\/\/|\/\*|\*|$)/

// Only a class-level @Path is an API root (a method-level one extends it), so look past the rest
// of the annotation block and check that a class or interface is declared next.
function annotatesType(lines, annotationIndex) {
  let index = annotationIndex + 1
  while (index < lines.length && ANNOTATION_BLOCK_LINE.test(lines[index])) index++
  return index < lines.length && /\b(class|interface)\s+\w/.test(lines[index])
}

// All backends run at @ApplicationPath("/") with no root path, so these are the real top-level
// paths. assemble.mjs only uses them to refine an edge label; they never create an edge.
function scanRestProvides(javaFiles, repoDir) {
  const rootsByModule = new Map() // module -> Set(root)
  for (const file of javaFiles) {
    const text = readText(file)
    if (!text.includes('@Path')) continue
    const lines = splitLines(text)
    for (let index = 0; index < lines.length; index++) {
      const pathMatch = lines[index].match(/@Path\(\s*"([^"]*)"/)
      if (!pathMatch || !annotatesType(lines, index)) continue
      const root = '/' + (pathMatch[1].split('/').filter(Boolean)[0] || '')
      if (root === '/') continue
      const module = moduleOf(repoDir, file)
      if (!rootsByModule.has(module)) rootsByModule.set(module, new Set())
      rootsByModule.get(module).add(root)
    }
  }
  return [...rootsByModule.entries()].map(([module, roots]) => ({ module, roots: [...roots].sort() }))
}

// ---- REST consumers (outbound URL config) ------------------------------------------------------
// These backends configure an outbound base URL (`sensor.data.access.url=https://...`) and call it
// with HttpClient/Retrofit. The host identifies the target service; the path is only a label.
// Infrastructure endpoints (auth, config, secrets, storage, health) aren't service-to-service REST.
// `notification.*` URLs are the {{baseUrl}} deep link in notification e-mails, not an API call.
const INFRA_KEY =
  /(datasource|jdbc|vault|keycloak|oidc|swagger|token-?url|liquibase|flyway|blob|storage|otel|otlp|kafka|schema.registry|notification)/i
const INFRA_HOST = /(vault|config-server|hashicorp-vault|localhost|microsoftonline|keycloak|schema-registry)/i
const INFRA_HEAD = new Set(['id', 'vault', 'localhost', 'config-server', 'hashicorp-vault'])
const URL_PROPERTY_LINE = /^\s*(?:%[\w-]+\.)?([\w.-]*(?:url|endpoint))\s*=\s*(.+)$/i
const HTTP_URL = /^https?:\/\/([^/\s"']+)(\/[^\s"']*)?/i
const ENV_INFIX = /\.(dev|test|pre|prod|demo|poc|nonprod|sandbox|e2e)(?=\.)/g

// Drops the port, the docker `_api_N` suffix and env infixes so assemble.mjs can resolve the host.
function normalizeHost(rawHost) {
  return rawHost
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/_api_\d+$/, '')
    .replace(ENV_INFIX, '.{env}')
}

// A bare IP host (e.g. a 127.0.0.1 loopback default) is not a service edge either.
function isInfraEndpoint({ propKey, host, hostHead, path: pathPrefix }) {
  return (
    INFRA_KEY.test(propKey) ||
    INFRA_HOST.test(host) ||
    INFRA_HEAD.has(hostHead) ||
    /^\d+$/.test(hostHead) ||
    /\bhealth\b/.test(pathPrefix)
  )
}

// One entry per (module, host, first path segment).
export function scanRestConsumes(propFiles, repoDir) {
  const consumers = new Map() // "module|host|segment" -> { module, propKey, host, hostHead, path, rawUrl }
  for (const file of propFiles) {
    const module = moduleOf(repoDir, file)
    for (const line of splitLines(readText(file))) {
      const propertyMatch = line.match(URL_PROPERTY_LINE)
      if (!propertyMatch) continue
      const propKey = propertyMatch[1]
      const urlMatch = resolvePlaceholders(propertyMatch[2]).match(HTTP_URL)
      if (!urlMatch) continue
      const [rawUrl, rawHost, rawPath] = urlMatch
      const host = normalizeHost(rawHost)
      const hostHead = host.split('.')[0]
      const segments = (rawPath || '/').split('/').filter(Boolean)
      const entry = {
        module,
        propKey,
        host,
        hostHead,
        path: '/' + segments.slice(0, PATH_SEGMENTS_IN_PREFIX).join('/'),
        rawUrl,
      }
      if (isInfraEndpoint(entry)) continue
      const key = `${module}|${host}|${segments[0] || ''}`
      if (!consumers.has(key)) consumers.set(key, entry)
    }
  }
  return [...consumers.values()]
}

// ---- Golden Path facts: database engine, log sink, tracer --------------------------------------
// Three states, told apart by whether the key is present: "Postgres" = determined, null = scanned
// and there is nothing, key absent = could not be determined. The `*Evidence` sibling holds the
// matched token so a verdict can be checked without re-scanning.
const DB_ENGINES = [
  ['Postgres', /postgresql|jdbc:postgres/i],
  ['MariaDB', /mariadb/i],
  ['MySQL', /mysql/i],
  ['SQL Server', /jdbc:sqlserver|mssql-jdbc/i],
  ['Oracle', /jdbc:oracle|ojdbc/i],
  ['MongoDB', /mongodb/i],
  ['H2', /jdbc:h2|quarkus-jdbc-h2|com\.h2database/i],
]
// Persistence is configured but the engine is not: report nothing rather than guess one.
const DB_ENGINELESS =
  /quarkus\.datasource\.|quarkus-hibernate|quarkus-agroal|quarkus-liquibase|quarkus-flyway/i
const LOG_SINKS = [
  ['Logz.io', /logz\.io|logzio/i],
  ['GELF', /logging-gelf|logstash-gelf/i],
  ['Logstash', /logstash/i],
  ['Logback', /logback/i],
  // Structured stdout, forwarded by a cluster-side collector: the destination is not in the repo.
  ['JSON console', /quarkus-logging-json|quarkus\.log\.console\.json/i],
]
const TRACERS = [
  ['OpenTelemetry', /quarkus-opentelemetry|opentelemetry-|quarkus\.otel\./i],
  ['OpenTracing (deprecated)', /opentracing|jaeger/i],
]

const withoutTestDependencies = (buildText) =>
  splitLines(
    buildText.replace(/<dependency>[\s\S]*?<\/dependency>/g, (dependency) =>
      /<scope>test<\/scope>/.test(dependency) ? '' : dependency,
    ),
  )
    .filter((line) => !/^\s*test[A-Z]/.test(line))
    .join('\n')

const withoutDevAndTestProfiles = (propertiesText) =>
  splitLines(propertiesText)
    .filter((line) => !/^\s*%(dev|test)/.test(line))
    .join('\n')

// Test scope is dropped because `testImplementation quarkus-jdbc-h2` would otherwise report H2
// for a Postgres service.
function goldenPathText(buildFiles, propFiles) {
  return [
    ...buildFiles.map((file) => withoutTestDependencies(readText(file))),
    ...propFiles.map((file) => withoutDevAndTestProfiles(readText(file))),
  ].join('\n')
}

function firstMatchingFact(text, candidates) {
  for (const [value, regex] of candidates) {
    const match = text.match(regex)
    if (match) return { value, evidence: match[0] }
  }
  return null
}

function databaseFacts(text) {
  const engine = firstMatchingFact(text, DB_ENGINES)
  if (engine) return { db: engine.value, dbEvidence: engine.evidence }
  // The `db` key is left out on purpose; the evidence says why.
  const engineless = text.match(DB_ENGINELESS)
  if (engineless) return { dbEvidence: engineless[0] }
  return { db: null }
}

function goldenPathFacts(text) {
  // No build file and no properties: nothing was scanned at all.
  if (!text.trim()) return {}
  const logSink = firstMatchingFact(text, LOG_SINKS)
  const tracer = firstMatchingFact(text, TRACERS)
  return {
    ...databaseFacts(text),
    ...(logSink ? { log: logSink.value, logEvidence: logSink.evidence } : { log: null }),
    ...(tracer ? { trace: tracer.value, traceEvidence: tracer.evidence } : { trace: null }),
  }
}

// ---- Curated internal frameworks (backend-extra.json `frameworkDeps`) ---------------------------
// The backend counterpart of the FE design-system dependency. Pure, so it can be unit-tested
// without cloned backends; the group ids live in data, not here.

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const isLiteralVersion = (version) => /^\d/.test(version)

// Gradle: "group:artifact:version", the version often a ${prop} reference.
function collectGradleCoordinates(buildText, group, artifacts, literalVersions) {
  const coordinate = new RegExp(`['"]${escapeRegex(group)}:([\\w.-]+):([^'"]*)['"]`, 'g')
  for (const [, artifact, version] of buildText.matchAll(coordinate)) {
    artifacts.add(artifact)
    if (isLiteralVersion(version)) literalVersions.add(version)
  }
}

// Maven: <groupId>group</groupId><artifactId>…</artifactId>[<version>…</version>]
function collectMavenCoordinates(buildText, group, artifacts, literalVersions) {
  const coordinate = new RegExp(
    `<groupId>\\s*${escapeRegex(group)}\\s*</groupId>\\s*<artifactId>([\\w.-]+)</artifactId>(?:\\s*<version>([^<]+)</version>)?`,
    'g',
  )
  for (const [, artifact, version] of buildText.matchAll(coordinate)) {
    artifacts.add(artifact)
    if (version && isLiteralVersion(version.trim())) literalVersions.add(version.trim())
  }
}

// The version is a `<name>Version` build property (or the configured `versionProp`), else the
// first literal version found in a coordinate.
export const extractFrameworkDeps = (buildTexts, propsText, frameworkDeps) => {
  const frameworks = {}
  for (const [name, config] of Object.entries(frameworkDeps || {})) {
    if (String(name).startsWith('_')) continue // _comment keys
    const group = typeof config === 'string' ? config : config?.group
    if (!group) continue
    const artifacts = new Set()
    const literalVersions = new Set()
    for (const buildText of buildTexts) {
      collectGradleCoordinates(buildText, group, artifacts, literalVersions)
      collectMavenCoordinates(buildText, group, artifacts, literalVersions)
    }
    if (!artifacts.size) continue
    const versionProp = (typeof config === 'object' && config.versionProp) || `${name}Version`
    const propVersion = propsText.match(new RegExp(`${escapeRegex(versionProp)}\\s*=\\s*([\\w.-]+)`))?.[1]
    frameworks[name] = {
      version: propVersion || [...literalVersions][0] || null,
      artifacts: [...artifacts].sort(),
    }
  }
  return frameworks
}

function loadFrameworkDeps() {
  try {
    const backendExtra = JSON.parse(fs.readFileSync(path.join(AUDIT, 'backend-extra.json'), 'utf8'))
    return backendExtra.frameworkDeps || {}
  } catch {
    return {}
  }
}

// ---- CLI -------------------------------------------------------------------------------------

function frameworkLabel(stack) {
  if (stack.framework && stack.frameworkVersion) return `${stack.framework} ${stack.frameworkVersion}`
  return stack.framework
}

function scanBackend(dir, frameworkDeps) {
  const stack = fs.existsSync(path.join(dir, 'pom.xml')) ? scanMaven(dir) : scanGradle(dir)
  const { propFiles, javaFiles, buildFiles } = collectSourceFiles(dir)
  const java = stack.java ? `Java ${stack.java}` : null
  return {
    ...gitInfo(dir),
    buildTool: stack.build,
    java,
    framework: frameworkLabel(stack),
    modules: stack.modules,
    // Chips for the graph node, in the FE chip style: short and version-bearing.
    tooling: [frameworkLabel(stack), java, stack.build].filter(Boolean),
    ...goldenPathFacts(goldenPathText(buildFiles, propFiles)),
    frameworks: extractFrameworkDeps(
      buildFiles.map(readText),
      readText(path.join(dir, 'gradle.properties')),
      frameworkDeps,
    ),
    messaging: scanMessaging(propFiles, dir),
    restProvides: scanRestProvides(javaFiles, dir),
    restConsumes: scanRestConsumes(propFiles, dir),
  }
}

function main() {
  const frameworkDeps = loadFrameworkDeps()
  const scanned = {}
  const missing = []
  for (const folder of listBackends()) {
    const dir = path.join(ROOT, folder)
    if (!fs.existsSync(path.join(dir, '.git'))) {
      missing.push(folder)
      continue
    }
    scanned[folder] = scanBackend(dir, frameworkDeps)
  }

  fs.writeFileSync(
    path.join(AUDIT, 'backend-tooling.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), scanned, missing }, null, 2),
  )
  const missingList = missing.length ? ' (' + missing.join(', ') + ')' : ''
  console.log(
    `wrote backend-tooling.json; scanned: ${Object.keys(scanned).length}, missing: ${missing.length}${missingList}`,
  )
}

// Run only when invoked directly, not when imported by a test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
