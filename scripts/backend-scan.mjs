// Backend tooling scanner — reads the cloned backend repos and extracts their stack
// (build tool, Java version, framework + version, multi-module layout) from build files.
//
// This is the file-scanning counterpart to github-inventory.mjs (which only sees API
// metadata): tooling versions live inside build.gradle / pom.xml and can only be read from
// a local checkout. Backends are scanned from ROOT (the same place the FE repos are read),
// so in CI the regenerate workflow must clone these repos alongside the frontends.
//
// Writes backend-tooling.json keyed by repo folder. Repos not present on disk are reported
// under `missing` rather than failing — so a partial checkout degrades gracefully.
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

import { AUDIT, ROOT, maybeFetch } from './_paths.mjs'
import { discoverBackendFolders } from './repos.mjs'

// Backend repos to scan: auto-discovered from the clones (git repo + build.gradle/pom.xml, no
// package.json) plus whatever BACKEND_REPOS names (the canonical CI list, space-separated —
// the same variable the regenerate workflow uses for cloning). Env-listed repos that aren't
// on disk are reported under `missing` so a partial checkout degrades visibly, not silently.
const envBackends = (process.env.BACKEND_REPOS || '').split(/\s+/).filter(Boolean)
const BACKENDS = [...new Set([...envBackends, ...discoverBackendFolders()])].sort()

const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const first = (re, s) => { const m = s.match(re); return m ? m[1] : null }
const all = (re, s) => [...s.matchAll(re)].map((m) => m[1])

const gitInfo = (dir) => {
  maybeFetch(dir)
  const g = (cmd) => { try { return execSync(cmd, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } }
  const branch = g('git rev-parse --abbrev-ref origin/HEAD')?.replace(/^origin\//, '') || g('git rev-parse --abbrev-ref HEAD')
  const ref = branch ? `origin/${branch}` : 'HEAD'
  // GitHub repo basename from the remote — the folder can lag a rename (e.g. the
  // skycore-booking-portal-backend checkout of the skycore-booking-portal repo), and the
  // inventory is keyed by the GitHub name.
  const repoName = (g('git config --get remote.origin.url') || '').match(/\/([^/]+?)(?:\.git)?$/)?.[1] || null
  return { defaultBranch: branch, lastCommit: g(`git log -1 --format=%cI ${ref}`) || g('git log -1 --format=%cI') , repoName }
}

const scanGradle = (dir) => {
  const props = read(path.join(dir, 'gradle.properties'))
  const build = read(path.join(dir, 'build.gradle')) || read(path.join(dir, 'build.gradle.kts'))
  const settings = read(path.join(dir, 'settings.gradle')) || read(path.join(dir, 'settings.gradle.kts'))
  const quarkus = first(/quarkusPlatformVersion\s*=\s*([\d.]+\w*)/i, props)
  return {
    // both Groovy (include 'x') and Kotlin DSL (include("x")) forms
    build: 'Gradle' + (all(/^\s*include\s*[('"]/gim, settings).length ? ' (multi-module)' : ''),
    java: first(/JavaLanguageVersion\.of\((\d+)\)/i, build) || first(/sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?(\d+)/i, build),
    framework: quarkus ? 'Quarkus' : (build.includes('spring-boot') ? 'Spring Boot' : null),
    frameworkVersion: quarkus,
    modules: all(/include\s*\(?\s*['"]:?([^'"]+)['"]/gi, settings),
  }
}

const scanMaven = (dir) => {
  const pom = read(path.join(dir, 'pom.xml'))
  const quarkus = first(/<quarkus\.platform\.version>([^<]+)/i, pom)
  return {
    build: 'Maven' + (all(/<module>/gi, pom).length ? ' (multi-module)' : ''),
    java: first(/<(?:maven\.compiler\.(?:source|release)|java\.version)>(\d+)/i, pom),
    framework: quarkus ? 'Quarkus' : (/spring-boot-starter-parent/.test(pom) ? 'Spring Boot' : null),
    frameworkVersion: quarkus,
    modules: all(/<module>([^<]+)<\/module>/gi, pom),
  }
}

// Module a source file belongs to: the first path segment under the repo root, unless that is
// `src` (a single-module repo lays out src/ at the root; multi-module repos like
// device-data-service put each module in its own top-level folder). Kafka + REST scanners share
// this so producers/consumers/providers are attributed to the same component ids.
const moduleOf = (repoDir, file) => {
  const seg = path.relative(repoDir, file).split(path.sep)[0]
  return seg === 'src' ? null : seg
}

// Single directory walk shared by every file scanner below (walking a 3000-file backend once, not
// three times): collects the application*.properties under src/main/resources (Kafka + outbound
// REST config), the *.java under src/main/java (JAX-RS providers) and every build file (dependency
// coordinates for the Golden Path facts — subproject build files too, since a multi-module repo
// declares its datasource in the module, not in the root build). Test trees and test-only
// modules are skipped.
const collectSourceFiles = (repoDir) => {
  const propFiles = [], javaFiles = [], buildFiles = []
  const walk = (dir, depth = 0) => {
    if (depth > 12) return
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'build', 'target', 'dist', '.gradle'].includes(e.name)) continue
        walk(path.join(dir, e.name), depth + 1)
        continue
      }
      const full = path.join(dir, e.name)
      if (/^application[^/]*\.properties$/.test(e.name) && dir.includes(`src${path.sep}main${path.sep}resources`)) propFiles.push(full)
      else if (e.name.endsWith('.java') && dir.includes(`src${path.sep}main${path.sep}java`)) javaFiles.push(full)
      // Test-only modules (integration-tests/, e2e/…) declare compile-scope H2 etc. — skip their build files.
      else if (
        /^(pom\.xml|build\.gradle(\.kts)?)$/.test(e.name) &&
        !path.relative(repoDir, dir).split(path.sep).some((s) => /^(tests?|e2e|it|.*-tests?)$/i.test(s))
      ) buildFiles.push(full)
    }
  }
  walk(repoDir)
  return { propFiles, javaFiles, buildFiles }
}

// Resolve `${var:default}` interpolations to their default and strip bare `${prefix}` placeholders
// — shared by topic names (`${kafka.env.prefix}skycore_logger`) and outbound URLs
// (`${DEVICE_DATA_ASSET_URL:https://device-data-asset...}`).
const resolvePlaceholders = (v) =>
  v.replace(/\$\{[^:}]*:([^}]*)\}/g, '$1').replace(/\$\{[^}]*\}/g, '').trim()

// ---- Kafka messaging channels (MicroProfile reactive messaging) --------------------------
// Records the mp.messaging.incoming.* / outgoing.* channels, attributed to the declaring module.
// The topic is the `.topic` override when set, else the channel name (the MP default). assemble.mjs
// matches producers to consumers by topic to derive service-to-service integrations from code.
const scanMessaging = (propFiles, repoDir) => {
  const channels = new Map() // module|direction|channel -> { module, direction, channel, topic }
  for (const file of propFiles) {
    const module = moduleOf(repoDir, file)
    const text = read(file)
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*mp\.messaging\.(incoming|outgoing)\.([^.=\s]+)\.([A-Za-z0-9_.-]+)\s*=\s*(.*)$/)
      if (!m) continue
      const [, direction, channel, prop, value] = m
      const key = `${module}|${direction}|${channel}`
      const cur = channels.get(key) || { module, direction, channel, topic: channel }
      if (prop === 'topic' && resolvePlaceholders(value)) cur.topic = resolvePlaceholders(value)
      channels.set(key, cur)
    }
  }
  return [...channels.values()]
}

// ---- REST providers (JAX-RS resource roots) ----------------------------------------------
// The exposed API roots of a backend = the CLASS-level @Path values (a method-level @Path merely
// extends its resource's root). We detect class-level by lookahead: the next code line after the
// annotation block declares a `class`/`interface`. All backends run at @ApplicationPath("/") with
// no quarkus.http.root-path, so these roots are the real top-level paths. assemble.mjs uses them
// to refine/confirm the channel label of a derived REST edge (they never gate edge creation).
const scanRestProvides = (javaFiles, repoDir) => {
  const byModule = new Map() // module -> Set(root)
  for (const file of javaFiles) {
    const text = read(file)
    if (!text.includes('@Path')) continue
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const pm = lines[i].match(/@Path\(\s*"([^"]*)"/)
      if (!pm) continue
      let j = i + 1 // skip further annotations, comments and blank lines to the declaration
      while (j < lines.length && /^\s*(@|\/\/|\/\*|\*|$)/.test(lines[j])) j++
      if (j >= lines.length || !/\b(class|interface)\s+\w/.test(lines[j])) continue
      const root = '/' + (pm[1].split('/').filter(Boolean)[0] || '')
      if (root === '/') continue
      const module = moduleOf(repoDir, file)
      if (!byModule.has(module)) byModule.set(module, new Set())
      byModule.get(module).add(root)
    }
  }
  return [...byModule.entries()].map(([module, roots]) => ({ module, roots: [...roots].sort() }))
}

// ---- REST consumers (outbound URL config) ------------------------------------------------
// These backends don't use @RegisterRestClient/WebClient/Feign — they configure an outbound base
// URL (`sensor.data.access.url=https://sensor-data-access...`) and call it via HttpClient/Retrofit.
// The HOST is the discriminating part of the URL (identifies the target service); the path is
// corroboration/label. Records one entry per (module, host, first-path-segment), normalizing the
// host (drop :port, docker `_api_N` suffix, and env infixes) so assemble.mjs can resolve it to a
// component. Infrastructure endpoints (auth, config, secrets, storage, health) are not
// service-to-service REST and are excluded. `notification.*` base-urls are also excluded: they are
// the deep-link base injected as {{baseUrl}} into notification e-mail bodies (see NotificationSender),
// i.e. a UI link in a template, not a runtime API call.
const INFRA_KEY = /(datasource|jdbc|vault|keycloak|oidc|swagger|token-?url|liquibase|flyway|blob|storage|otel|otlp|kafka|schema.registry|notification)/i
const INFRA_HOST = /(vault|config-server|hashicorp-vault|localhost|microsoftonline|keycloak|schema-registry)/i
const INFRA_HEAD = new Set(['id', 'vault', 'localhost', 'config-server', 'hashicorp-vault'])
const scanRestConsumes = (propFiles, repoDir) => {
  const out = new Map() // module|host|seg -> { module, propKey, host, hostHead, path, rawUrl }
  for (const file of propFiles) {
    const module = moduleOf(repoDir, file)
    for (const line of read(file).split(/\r?\n/)) {
      const m = line.match(/^\s*(?:%[\w-]+\.)?([\w.-]*(?:url|endpoint))\s*=\s*(.+)$/i)
      if (!m) continue
      const propKey = m[1]
      const um = resolvePlaceholders(m[2]).match(/^https?:\/\/([^/\s"']+)(\/[^\s"']*)?/i)
      if (!um) continue
      let host = um[1].toLowerCase().replace(/:\d+$/, '').replace(/_api_\d+$/, '')
      host = host.replace(/\.(dev|test|pre|prod|demo|poc|nonprod|sandbox|e2e)(?=\.)/g, '.{env}')
      const hostHead = host.split('.')[0]
      const segs = (um[2] || '/').split('/').filter(Boolean)
      const pathPrefix = '/' + segs.slice(0, 2).join('/')
      // Drop infra endpoints and bare IP hosts (a 127.0.0.1 self/loopback default is not a service edge).
      if (INFRA_KEY.test(propKey) || INFRA_HOST.test(host) || INFRA_HEAD.has(hostHead) || /^\d+$/.test(hostHead) || /\bhealth\b/.test(pathPrefix)) continue
      const key = `${module}|${host}|${segs[0] || ''}`
      if (!out.has(key)) out.set(key, { module, propKey, host, hostHead, path: pathPrefix, rawUrl: `https://${um[1]}${um[2] || ''}` })
    }
  }
  return [...out.values()]
}

// ---- Golden Path facts: database engine, log sink, tracer ---------------------------------
// Three states, told apart by PRESENCE of the key, not by value: "Postgres" = determined,
// null = scanned and sure there is nothing, key absent = could not be determined.
// A `*Evidence` sibling records the matched token so a verdict can be checked without re-scanning.
const DB_ENGINES = [
  ['Postgres', /postgresql|jdbc:postgres/i],
  ['MariaDB', /mariadb/i],
  ['MySQL', /mysql/i],
  ['SQL Server', /jdbc:sqlserver|mssql-jdbc/i],
  ['Oracle', /jdbc:oracle|ojdbc/i],
  ['MongoDB', /mongodb/i],
  ['H2', /jdbc:h2|quarkus-jdbc-h2|com\.h2database/i],
]
// Persistence is configured but the engine is not: report nothing rather than guess an engine.
const DB_ENGINELESS = /quarkus\.datasource\.|quarkus-hibernate|quarkus-agroal|quarkus-liquibase|quarkus-flyway/i
const LOG_SINKS = [
  ['Logz.io', /logz\.io|logzio/i],
  ['GELF', /logging-gelf|logstash-gelf/i],
  ['Logstash', /logstash/i],
  ['Logback', /logback/i],
  // Structured stdout, forwarded by a cluster-side collector — the destination is not in the repo.
  ['JSON console', /quarkus-logging-json|quarkus\.log\.console\.json/i],
]
const TRACERS = [
  ['OpenTelemetry', /quarkus-opentelemetry|opentelemetry-|quarkus\.otel\./i],
  ['OpenTracing (deprecated)', /opentracing|jaeger/i],
]

// Build files + application*.properties, with test-scoped dependencies and dev/test profile lines
// dropped — `testImplementation quarkus-jdbc-h2` would otherwise report H2 for a Postgres service.
const goldenPathText = (buildFiles, propFiles) => [
  ...buildFiles.map((f) => read(f)
    .replace(/<dependency>[\s\S]*?<\/dependency>/g, (d) => /<scope>test<\/scope>/.test(d) ? '' : d)
    .split(/\r?\n/).filter((l) => !/^\s*test[A-Z]/.test(l)).join('\n')),
  ...propFiles.map((f) => read(f).split(/\r?\n/).filter((l) => !/^\s*%(dev|test)/.test(l)).join('\n')),
].join('\n')

const goldenPathFacts = (text) => {
  if (!text.trim()) return {}   // no build file and no properties: nothing was scanned at all
  const pick = (list) => {
    for (const [value, re] of list) { const m = text.match(re); if (m) return { value, evidence: m[0] } }
    return null
  }
  const db = pick(DB_ENGINES), log = pick(LOG_SINKS), trace = pick(TRACERS)
  const engineless = db ? null : text.match(DB_ENGINELESS)
  return {
    ...(db ? { db: db.value, dbEvidence: db.evidence }
      : engineless ? { dbEvidence: engineless[0] }   // key omitted on purpose, evidence says why
      : { db: null }),
    ...(log ? { log: log.value, logEvidence: log.evidence } : { log: null }),
    ...(trace ? { trace: trace.value, traceEvidence: trace.evidence } : { trace: null }),
  }
}

// ---- curated internal frameworks (backend-extra.json `frameworkDeps`) ---------------------
// Which curated internal framework(s) a repo builds on — e.g. a shared platform library, the
// backend counterpart of the FE design-system dependency. Reports the artifacts pulled and the
// version (a `<name>Version` build property, else a literal in the coordinate). Pure function so
// it's unit-testable without cloned backends; the group ids live in DATA, not here.
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const extractFrameworkDeps = (buildTexts, propsText, frameworkDeps) => {
  const out = {}
  for (const [name, conf] of Object.entries(frameworkDeps || {})) {
    if (String(name).startsWith('_')) continue // _comment keys
    const group = typeof conf === 'string' ? conf : conf?.group
    if (!group) continue
    const artifacts = new Set(), literalVersions = new Set()
    for (const txt of buildTexts) {
      // Gradle: "group:artifact:version" (version often a ${prop} reference)
      for (const m of txt.matchAll(new RegExp(`['"]${esc(group)}:([\\w.-]+):([^'"]*)['"]`, 'g'))) {
        artifacts.add(m[1])
        if (/^\d/.test(m[2])) literalVersions.add(m[2])
      }
      // Maven: <groupId>group</groupId><artifactId>…</artifactId>[<version>…</version>]
      for (const m of txt.matchAll(new RegExp(`<groupId>\\s*${esc(group)}\\s*</groupId>\\s*<artifactId>([\\w.-]+)</artifactId>(?:\\s*<version>([^<]+)</version>)?`, 'g'))) {
        artifacts.add(m[1])
        if (m[2] && /^\d/.test(m[2].trim())) literalVersions.add(m[2].trim())
      }
    }
    if (!artifacts.size) continue
    const versionProp = (typeof conf === 'object' && conf.versionProp) || `${name}Version`
    const propVersion = (propsText.match(new RegExp(`${esc(versionProp)}\\s*=\\s*([\\w.-]+)`)) || [])[1]
    out[name] = { version: propVersion || [...literalVersions][0] || null, artifacts: [...artifacts].sort() }
  }
  return out
}
let FRAMEWORK_DEPS = {}
try { FRAMEWORK_DEPS = JSON.parse(fs.readFileSync(path.join(AUDIT, 'backend-extra.json'), 'utf8')).frameworkDeps || {} } catch {}

// ---- CLI (run only when invoked directly, so tests can import extractFrameworkDeps) --------
import { fileURLToPath } from 'node:url'
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {

const scanned = {}, missing = []
for (const folder of BACKENDS) {
  const dir = path.join(ROOT, folder)
  if (!fs.existsSync(path.join(dir, '.git'))) { missing.push(folder); continue }
  const isMaven = fs.existsSync(path.join(dir, 'pom.xml'))
  const stack = isMaven ? scanMaven(dir) : scanGradle(dir)
  const { propFiles, javaFiles, buildFiles } = collectSourceFiles(dir)
  scanned[folder] = {
    ...gitInfo(dir),
    buildTool: stack.build,
    java: stack.java ? `Java ${stack.java}` : null,
    framework: stack.framework && stack.frameworkVersion ? `${stack.framework} ${stack.frameworkVersion}` : stack.framework,
    modules: stack.modules,
    // tooling chips for the graph node (matches the FE chip style: short, version-bearing)
    tooling: [stack.framework && stack.frameworkVersion ? `${stack.framework} ${stack.frameworkVersion}` : stack.framework, stack.java ? `Java ${stack.java}` : null, stack.build].filter(Boolean),
    ...goldenPathFacts(goldenPathText(buildFiles, propFiles)),
    frameworks: extractFrameworkDeps(buildFiles.map(read), read(path.join(dir, 'gradle.properties')), FRAMEWORK_DEPS),
    messaging: scanMessaging(propFiles, dir),
    restProvides: scanRestProvides(javaFiles, dir),
    restConsumes: scanRestConsumes(propFiles, dir),
  }
}

fs.writeFileSync(path.join(AUDIT, 'backend-tooling.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), scanned, missing }, null, 2))
console.log(`wrote backend-tooling.json; scanned: ${Object.keys(scanned).length}, missing: ${missing.length}${missing.length ? ' (' + missing.join(', ') + ')' : ''}`)

} // end CLI guard
