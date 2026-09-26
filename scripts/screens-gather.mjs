// Per-FE-client screen extraction with best-effort endpoint attribution. For each FE repo:
//   1. find router files (*Router*.tsx, or files using <Route>/createBrowserRouter),
//   2. pair each route `element` with its nearest `path` literal and its roles,
//   3. resolve the screen component to a file (relative or tsconfig path alias),
//   4. walk that file's local import graph collecting endpoints and design-system imports.
// Repos with no parseable routers fall back to folder convention (src/pages|screens|views/*).
//
// Writes scripts/screens-out.json: { perRepo: { <folder>: { method, routerFiles, screens } } }.
// Heuristic by design: widely shared hooks over-attribute and dynamic endpoint strings are missed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ROOT, AUDIT, maybeFetch } from './_paths.mjs'
import { repos } from './repos.mjs'
import { extractEndpointsFromText, extractApiCallsFromText } from './lib/endpoints.mjs'

const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js']
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '__snapshots__'])
const TSCONFIG_NAMES = ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json']
const SCREEN_FOLDERS = ['pages', 'screens', 'views']
// Wrappers and redirects, never the screen itself.
const SKIP_COMPONENTS = new Set([
  'Navigate',
  'Outlet',
  'Fragment',
  'Suspense',
  'Routes',
  'Route',
  'RouterProvider',
])
const MAX_TRACED_FILES = 600
const MAX_TRACE_DEPTH = 8
const PATH_LOOKAHEAD_CHARS = 600
// For path-first JSX: <Route path=… element=…>.
const PATH_LOOKBEHIND_CHARS = 200

const readFile = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const relativePosix = (repoDir, absolutePath) =>
  path.relative(repoDir, absolutePath).split(path.sep).join('/')

const lastItem = (items) => (items.length ? items[items.length - 1] : null)

const pushUnique = (items, item) => {
  if (!items.includes(item)) items.push(item)
}

function listSourceFiles(dir, files = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) listSourceFiles(entryPath, files)
    } else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
      files.push(entryPath)
    }
  }
  return files
}

// ---- Module resolution -----------------------------------------------------------------------

// tsconfig allows comments and trailing commas, which JSON.parse doesn't. Strings are matched
// first so a `/*` or `//` inside one (like "@/*") is kept.
const STRING_OR_COMMENT = /("(?:[^"\\\n]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g
const STRING_OR_TRAILING_COMMA = /("(?:[^"\\\n]|\\.)*")|,(\s*[}\]])/g

const stripJsonComments = (raw) =>
  raw
    .replace(STRING_OR_COMMENT, (match, string) => string ?? '')
    .replace(STRING_OR_TRAILING_COMMA, (match, string, closing) => string ?? closing)

export function readTsPaths(repoDir) {
  for (const name of TSCONFIG_NAMES) {
    const raw = readFile(path.join(repoDir, name))
    if (!raw) continue
    try {
      const compilerOptions = JSON.parse(stripJsonComments(raw)).compilerOptions || {}
      return { baseUrl: compilerOptions.baseUrl || '.', paths: compilerOptions.paths || {} }
    } catch {
      // Unparseable: try the next candidate.
    }
  }
  return { baseUrl: '.', paths: {} }
}

function resolveFile(base) {
  for (const extension of SOURCE_EXTENSIONS) {
    if (fs.existsSync(base + extension)) return base + extension
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const indexFile = path.join(base, 'index' + extension)
    if (fs.existsSync(indexFile)) return indexFile
  }
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base
  return null
}

// Candidates from tsconfig `paths`, e.g. "*": ["./src/*"] or "@/*": ["src/*"].
function aliasCandidates(specifier, paths, baseDir) {
  const candidates = []
  for (const [pattern, targets] of Object.entries(paths)) {
    const starIndex = pattern.indexOf('*')
    if (starIndex < 0) {
      if (pattern === specifier) {
        for (const target of targets) candidates.push(path.join(baseDir, target))
      }
      continue
    }
    const prefix = pattern.slice(0, starIndex)
    const suffix = pattern.slice(starIndex + 1)
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue
    const wildcard = specifier.slice(prefix.length, specifier.length - suffix.length)
    for (const target of targets) candidates.push(path.join(baseDir, target.replace('*', wildcard)))
  }
  return candidates
}

// Returns resolve(fromFile, specifier) -> absolute path inside the repo, or null for external
// packages and unresolved aliases.
function makeResolver(repoDir, tsPaths) {
  const baseDir = path.join(repoDir, tsPaths.baseUrl || '.')
  return (fromFile, specifier) => {
    if (!specifier || specifier.startsWith('node:')) return null
    if (specifier.startsWith('.')) return resolveFile(path.resolve(path.dirname(fromFile), specifier))
    for (const candidate of aliasCandidates(specifier, tsPaths.paths, baseDir)) {
      const file = resolveFile(candidate)
      if (file) return file
    }
    // baseUrl-relative, which also covers "*": ["./src/*"].
    const file = resolveFile(path.join(baseDir, specifier))
    if (file && file.startsWith(repoDir)) return file
    return null
  }
}

const IMPORT_SPECIFIERS = [
  /(?:import|export)\s+[^'"]*?\s+from\s*['"]([^'"]+)['"]/g,
  /import\s*['"]([^'"]+)['"]/g, // side-effect import
  /import\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import
]

function importSpecifiers(text) {
  const specifiers = new Set()
  for (const regex of IMPORT_SPECIFIERS) {
    for (const match of text.matchAll(regex)) specifiers.add(match[1])
  }
  return [...specifiers]
}

// ---- Router parsing --------------------------------------------------------------------------

const DEFAULT_IMPORT =
  /import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s*['"]([^'"]+)['"]/g
const NAMED_IMPORT = /import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s+from\s*['"]([^'"]+)['"]/g
// const X = lazy(() => import('spec')), also React.lazy, loadable…
const LAZY_IMPORT = /const\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

// Component identifier -> import specifier, from a router file's imports.
export const importMap = (text) => {
  const specifierByName = {}
  for (const [, name, specifier] of text.matchAll(DEFAULT_IMPORT)) specifierByName[name] = specifier
  for (const [, namedList, specifier] of text.matchAll(NAMED_IMPORT)) {
    for (const part of namedList.split(',')) {
      // `B as C` binds the local name C.
      const localName = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim()
      if (localName) specifierByName[localName] = specifier
    }
  }
  for (const [, name, specifier] of text.matchAll(LAZY_IMPORT)) specifierByName[name] = specifier
  return specifierByName
}

const ROUTE_ELEMENT = /element\s*[:=]\s*\{?\s*(<[\s\S]{0,200}?>)/g
const ROUTE_PATH = /path\s*[:=]\s*['"]([^'"]+)['"]/
const ROUTE_PATHS = new RegExp(ROUTE_PATH, 'g')
const ROUTE_ROLES = /(?:necessary|sufficient)Roles\s*[:=]\s*\[([^\]]*)\]/
// userRoles.ASSET or a quoted 'ASSET'.
const ROLE_ENTRY = /\.([A-Za-z0-9_]+)|['"]([^'"]+)['"]/g

const screenComponentOf = (elementText) =>
  [...elementText.matchAll(/<([A-Z][\w$]*)/g)]
    .map((match) => match[1])
    .find((component) => !SKIP_COMPONENTS.has(component))

// Element-first: the nearest path after the element. Path-first JSX: the last path before it
// (the closest one, not an earlier sibling's).
function routePathNear(text, elementIndex) {
  const ahead = text.slice(elementIndex, elementIndex + PATH_LOOKAHEAD_CHARS)
  const behind = text.slice(Math.max(0, elementIndex - PATH_LOOKBEHIND_CHARS), elementIndex)
  const pathMatch = ahead.match(ROUTE_PATH) || lastItem([...behind.matchAll(ROUTE_PATHS)])
  return pathMatch ? pathMatch[1] : null
}

function routeRolesNear(text, elementIndex) {
  const ahead = text.slice(elementIndex, elementIndex + PATH_LOOKAHEAD_CHARS)
  const rolesMatch = ROUTE_ROLES.exec(ahead)
  if (!rolesMatch) return []
  return [...rolesMatch[1].matchAll(ROLE_ENTRY)].map((match) => match[1] || match[2]).filter(Boolean)
}

// One route per `element` anchor, with its nearest path and roles.
export const parseRoutes = (text) => {
  const routes = []
  for (const elementMatch of text.matchAll(ROUTE_ELEMENT)) {
    const component = screenComponentOf(elementMatch[1])
    if (!component) continue
    routes.push({
      component,
      path: routePathNear(text, elementMatch.index),
      roles: routeRolesNear(text, elementMatch.index),
    })
  }
  return routes
}

// ---- Design-system imports -------------------------------------------------------------------
// The package list is config.json `uiPackages`, as for isUiPkg in graph.js. With none configured
// nothing matches.

function readAppConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(AUDIT, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

const appConfig = readAppConfig()
const UI_PACKAGES = Array.isArray(appConfig.uiPackages) ? appConfig.uiPackages : []
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const UI_IMPORT = UI_PACKAGES.length
  ? new RegExp(
      `import\\s+(?:[A-Za-z0-9_$]+\\s*,\\s*)?\\{([^}]*)\\}\\s+from\\s*['"](?:${UI_PACKAGES.map(escapeRegex).join('|')})['"]`,
      'g',
    )
  : null

// Records the exported name, before any `as` alias.
export const extractUiComponents = (text, set = new Set()) => {
  if (!UI_IMPORT) return set
  for (const [, namedList] of text.matchAll(UI_IMPORT)) {
    for (const part of namedList.split(',')) {
      const exportedName = part
        .trim()
        .split(/\s+as\s+/)[0]
        .trim()
      if (exportedName && /^[A-Za-z]/.test(exportedName)) set.add(exportedName)
    }
  }
  return set
}

// ---- Endpoint attribution --------------------------------------------------------------------

function collectFromText(text, endpoints, components) {
  extractEndpointsFromText(text, endpoints)
  extractApiCallsFromText(text, endpoints)
  extractUiComponents(text, components)
}

// Breadth-first over the screen's local import graph, capped by depth and file count.
function traceImportGraph(startFile, resolve) {
  const endpoints = new Set()
  const components = new Set()
  const seen = new Set([startFile])
  let frontier = [startFile]
  let scanned = 0
  for (let depth = 0; depth <= MAX_TRACE_DEPTH && frontier.length && scanned < MAX_TRACED_FILES; depth++) {
    const next = []
    for (const file of frontier) {
      if (scanned >= MAX_TRACED_FILES) break
      scanned++
      const text = readFile(file)
      if (!text) continue
      collectFromText(text, endpoints, components)
      for (const specifier of importSpecifiers(text)) {
        const target = resolve(file, specifier)
        if (!target || seen.has(target)) continue
        seen.add(target)
        next.push(target)
      }
    }
    frontier = next
  }
  return { endpoints: [...endpoints].sort(), components: [...components].sort(), filesScanned: scanned }
}

// Folder-method screens often have no resolvable entry file (the component sits a few levels
// down) and their repos often have no aliases, so the import walk stalls. The folder is the screen
// boundary, so scanning it whole is simpler and complete.
function traceDirectory(dir) {
  const endpoints = new Set()
  const components = new Set()
  const files = listSourceFiles(dir).slice(0, MAX_TRACED_FILES)
  for (const file of files) {
    const text = readFile(file)
    if (text) collectFromText(text, endpoints, components)
  }
  return { endpoints: [...endpoints].sort(), components: [...components].sort(), filesScanned: files.length }
}

function traceScreen(screen, resolve) {
  if (screen.dir) return traceDirectory(screen.dir)
  if (screen.file) return traceImportGraph(screen.file, resolve)
  return { endpoints: [], components: [], filesScanned: 0 }
}

// ---- Per-repo gathering ----------------------------------------------------------------------

const screenName = (component, routePath) =>
  component || (routePath || '').replace(/^\//, '').split('/')[0] || 'screen'

function isRouterFile(file) {
  if (/Router[\w]*\.[jt]sx?$/.test(path.basename(file))) return true
  return /<Route[\s>]|createBrowserRouter|createRoutesFromElements/.test(readFile(file))
}

// A component routed from several places becomes one screen with all its paths and roles.
function screensFromRouters(routerFiles, resolve) {
  const screenByComponent = new Map()
  for (const routerFile of routerFiles) {
    const text = readFile(routerFile)
    const specifierByName = importMap(text)
    for (const route of parseRoutes(text)) {
      const specifier = specifierByName[route.component]
      const file = specifier ? resolve(routerFile, specifier) : null
      const existing = screenByComponent.get(route.component)
      if (!existing) {
        screenByComponent.set(route.component, {
          component: route.component,
          paths: route.path ? [route.path] : [],
          roles: [...route.roles],
          file,
        })
        continue
      }
      if (route.path) pushUnique(existing.paths, route.path)
      for (const role of route.roles) pushUnique(existing.roles, role)
      if (!existing.file && file) existing.file = file
    }
  }
  return [...screenByComponent.values()]
}

function screensFromFolders(srcDir, resolve) {
  const screens = []
  for (const folderName of SCREEN_FOLDERS) {
    const folder = path.join(srcDir, folderName)
    if (!fs.existsSync(folder)) continue
    // resolve() uses dirname(fromFile), so anchor on a file inside the folder.
    const anchor = path.join(folder, 'index.tsx')
    const resolveEntry = (entry) => resolve(anchor, './' + entry.name)
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const stem = path.basename(entry.name, path.extname(entry.name))
      if (entry.isDirectory()) {
        const dir = path.join(folder, entry.name)
        screens.push({ component: entry.name, paths: [], roles: [], file: resolveEntry(entry), dir })
      } else if (/\.[jt]sx$/.test(entry.name) && /^[A-Z]/.test(stem)) {
        // Loose PascalCase component files only; utils, constants and index are skipped.
        screens.push({ component: stem, paths: [], roles: [], file: resolveEntry(entry) })
      }
    }
  }
  return screens
}

function screenFileLabel(repoDir, screen) {
  if (screen.file) return relativePosix(repoDir, screen.file)
  if (screen.dir) return relativePosix(repoDir, screen.dir) + '/'
  return null
}

function describeScreen(repoDir, screen, resolve) {
  const trace = traceScreen(screen, resolve)
  return {
    name: screenName(screen.component, screen.paths[0]),
    component: screen.component,
    path: screen.paths[0] || null,
    paths: screen.paths,
    roles: screen.roles,
    file: screenFileLabel(repoDir, screen),
    endpoints: trace.endpoints,
    components: trace.components || [],
    filesScanned: trace.filesScanned,
  }
}

// A screen with no path, file, endpoints or components carries nothing.
const carriesInformation = (screen) =>
  screen.path || screen.file || screen.endpoints.length || screen.components.length

function gatherRepo(folder) {
  const repoDir = path.join(ROOT, folder)
  const srcDir = path.join(repoDir, 'src')
  if (!fs.existsSync(srcDir)) return null
  maybeFetch(repoDir)
  const resolve = makeResolver(repoDir, readTsPaths(repoDir))
  const routerFiles = listSourceFiles(srcDir).filter(isRouterFile)

  let method = 'router'
  let screens = screensFromRouters(routerFiles, resolve)
  if (!screens.some((screen) => screen.file)) {
    method = 'folder'
    screens = screensFromFolders(srcDir, resolve)
  }

  const described = screens
    .map((screen) => describeScreen(repoDir, screen, resolve))
    .filter(carriesInformation)
  described.sort((a, b) => a.name.localeCompare(b.name))
  return { method, routerFiles: routerFiles.length, screens: described }
}

function main() {
  const perRepo = {}
  for (const folder of repos.feInOrg) {
    const repoScreens = gatherRepo(folder)
    if (!repoScreens) continue
    perRepo[folder] = repoScreens
    const withEndpoints = repoScreens.screens.filter((screen) => screen.endpoints.length).length
    console.log(
      `  ${folder}: ${repoScreens.screens.length} screens (${repoScreens.method}), ${withEndpoints} with endpoints`,
    )
  }
  fs.writeFileSync(path.join(AUDIT, 'scripts/screens-out.json'), JSON.stringify({ perRepo }, null, 2))
  console.log('done; repos with screens:', Object.keys(perRepo).length)
}

// Run only when invoked directly, not when imported by a test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
