// Per-FE-client screen extraction with best-effort endpoint attribution. For each FE repo:
//   1. find router files (*Router*.tsx, or files using <Route>/createBrowserRouter),
//   2. pair each route `element` with the `path` and roles of the same route object or tag,
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

const readFile = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const relativePosix = (repoDir, absolutePath) =>
  path.relative(repoDir, absolutePath).split(path.sep).join('/')

const pushUnique = (items, item) => {
  if (!items.includes(item)) items.push(item)
}
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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

// Ends where the element's JSX starts: `element={<X />}`, `element: <X />` or `element: (<X />)`.
const ROUTE_ELEMENT = /element\s*[:=]\s*[{(]?\s*(?=<)/g
const ROUTE_PATH = /path\s*[:=]\s*['"]([^'"]+)['"]/
// `necessaryRoles: <expr>` in route objects, `necessaryRoles={<expr>}` as a JSX attribute.
const ROUTE_ROLES = /(?:necessary|sufficient)Roles\s*[:=]\s*\{?/g
const TAG_NAME = /[\w$]*/y

// Index just past the `}` matching the `{` at openIndex.
function closingBraceEnd(text, openIndex) {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '{') depth++
    if (text[i] === '}') depth--
    if (depth === 0) return i + 1
  }
  return text.length
}

// Index just past the `>` closing the tag at tagIndex, skipping `{…}` attribute values.
function tagEnd(text, tagIndex) {
  let i = tagIndex + 1
  while (i < text.length && text[i] !== '>') {
    i = text[i] === '{' ? closingBraceEnd(text, i) : i + 1
  }
  return i + 1
}

function tagName(text, tagIndex) {
  TAG_NAME.lastIndex = tagIndex + 1
  return TAG_NAME.exec(text)[0]
}

// The opening tags (with nesting depth) of the JSX element starting at `start`, and where it ends.
// `{…}` children are skipped, so a Suspense fallback is not mistaken for the screen.
function walkJsxElement(text, start) {
  const tags = []
  let depth = 0
  let i = start
  while (i < text.length) {
    if (text[i] === '{') {
      i = closingBraceEnd(text, i)
      continue
    }
    if (text[i] !== '<') {
      i++
      continue
    }
    const end = tagEnd(text, i)
    if (text[i + 1] === '/') {
      depth--
    } else {
      tags.push({ name: tagName(text, i), depth })
      if (text[end - 2] !== '/') depth++
    }
    i = end
    if (depth === 0) break
  }
  return { tags, end: i }
}

// The deepest component, so wrappers like <Suspense> or <RequireAuth> are looked through.
function screenComponentOf(tags) {
  let screen = null
  for (const tag of tags) {
    if (!/^[A-Z]/.test(tag.name) || SKIP_COMPONENTS.has(tag.name)) continue
    if (!screen || tag.depth > screen.depth) screen = tag
  }
  return screen?.name
}

// The route owning an element: the `{…}` object or JSX tag (<Route>, <PrivateRoute>…) around it.
// Walks back over balanced brackets and whole JSX elements; null when the element is in neither.
function enclosingRoute(text, elementIndex) {
  let bracketDepth = 0
  let closedTags = 0
  for (let i = elementIndex - 1; i >= 0; i--) {
    const char = text[i]
    if ('}])'.includes(char)) {
      bracketDepth++
    } else if ('{[('.includes(char)) {
      if (bracketDepth === 0) {
        return char === '{' ? { start: i, end: closingBraceEnd(text, i), isObject: true } : null
      }
      bracketDepth--
    } else if (bracketDepth > 0) {
      continue
    } else if (char === '>' && text[i - 1] !== '=') {
      closedTags++
    } else if (char === '<' && /[A-Za-z/]/.test(text[i + 1])) {
      if (closedTags === 0 && text[i + 1] !== '/') return { start: i, end: tagEnd(text, i), isObject: false }
      closedTags--
    }
  }
  return null
}

// The route's own properties, without its element and, for objects, without nested child routes.
function routeOwnText(text, route, element) {
  const ownText =
    text.slice(route.start, element.start) +
    ' '.repeat(element.end - element.start) +
    text.slice(element.end, route.end)
  if (!route.isObject) return ownText
  let depth = 0
  let topLevel = ''
  for (const char of ownText) {
    if (char === '{') depth++
    if (depth === 1) topLevel += char
    if (char === '}') depth--
  }
  return topLevel
}

// ---- Role expressions ----
// Roles are read statically: array literals, named constants, spreads, `.concat()` and zero-argument
// helpers returning a list, followed through imports and re-exports. Anything that needs runtime
// values (arguments, .filter(), conditionals) is reported as unresolved instead of guessed.

const OPENERS = '([{'
const CLOSERS = ')]}'
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const HELPER_CALL = /^([A-Za-z_$][\w$]*)\(\s*\)$/
const TYPE_ASSERTION = /\s+as\s+[\w$.<>[\]\s|]+$/
// `import { a, b as c } from 'x'` and `export { a, b as c } from 'x'`.
const NAMED_BINDINGS =
  /(?:import|export)\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
const STAR_EXPORT = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g
// Name lookups (files followed, spreads and helpers resolved) allowed per route expression, so a
// long or cyclic chain ends.
const MAX_ROLE_LOOKUPS = 24

// The expression starting at `start`: up to a top-level `,` or `;`, an unmatched closing bracket,
// or a line break that isn't followed by a `.method()` continuation.
function expressionAt(text, start) {
  let depth = 0
  let quote = null
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      if (char === '\\') i++
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (OPENERS.includes(char)) depth++
    else if (CLOSERS.includes(char)) {
      if (depth === 0) return text.slice(start, i).trim()
      depth--
    } else if (depth === 0 && (char === ',' || char === ';')) {
      return text.slice(start, i).trim()
    } else if (depth === 0 && char === '\n' && !/^\s*\./.test(text.slice(i + 1))) {
      const expression = text.slice(start, i).trim()
      if (expression) return expression
    }
  }
  return text.slice(start).trim()
}

// `text` split on top-level commas.
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let partStart = 0
  for (let i = 0; i < text.length; i++) {
    if (OPENERS.includes(text[i])) depth++
    else if (CLOSERS.includes(text[i])) depth--
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(partStart, i))
      partStart = i + 1
    }
  }
  parts.push(text.slice(partStart))
  return parts.map((part) => part.trim()).filter(Boolean)
}

// Index of the bracket matching the one closing at `closeIndex`, scanning backwards.
function matchingOpener(text, closeIndex) {
  let depth = 0
  for (let i = closeIndex; i >= 0; i--) {
    if (CLOSERS.includes(text[i])) depth++
    else if (OPENERS.includes(text[i]) && --depth === 0) return i
  }
  return -1
}

// Strips `as const`-style assertions and parentheses that wrap the whole expression.
function unwrap(expression) {
  let current = expression.trim()
  for (;;) {
    const next = current.replace(TYPE_ASSERTION, '').trim()
    const wrapped = next.startsWith('(') && next.endsWith(')') && matchingOpener(next, next.length - 1) === 0
    const unwrapped = wrapped ? next.slice(1, -1).trim() : next
    if (unwrapped === current) return current
    current = unwrapped
  }
}

// An array literal's entries: `...spread` expressions and roles (userRoles.ASSET or 'ASSET').
function rolesInList(body, lookup, state) {
  const roles = []
  for (const entry of splitTopLevel(body)) {
    if (entry.startsWith('...')) {
      for (const role of evaluateRoles(entry.slice(3), lookup, state) || []) pushUnique(roles, role)
      continue
    }
    const match = /^[\w$.]*\.([A-Za-z0-9_]+)$|^['"]([^'"]+)['"]$/.exec(entry)
    const role = match?.[1] || match?.[2]
    if (role) pushUnique(roles, role)
    else state.unresolved = true
  }
  return roles
}

// The roles an expression evaluates to, or null when it can't be read statically. Partial results
// (a list with one unreadable spread) keep what was read and flag state.unresolved.
function evaluateRoles(expression, lookup, state) {
  const roles = evaluateOrNull(expression, lookup, state)
  if (roles == null) state.unresolved = true
  return roles
}

function evaluateOrNull(rawExpression, lookup, state) {
  const expression = unwrap(rawExpression)
  if (!expression) return null
  if (IDENTIFIER.test(expression)) return lookup(expression, false)
  const helper = HELPER_CALL.exec(expression)
  if (helper) return lookup(helper[1], true)
  if (!expression.endsWith(')') && !expression.endsWith(']')) return null
  const opener = matchingOpener(expression, expression.length - 1)
  if (opener === 0 && expression.startsWith('[')) return rolesInList(expression.slice(1, -1), lookup, state)
  const callee = expression.slice(0, opener)
  if (opener <= 0 || expression[opener] !== '(' || !callee.endsWith('.concat')) return null
  const receiver = evaluateRoles(callee.slice(0, -'.concat'.length), lookup, state)
  if (receiver == null) return null
  const roles = [...receiver]
  for (const argument of splitTopLevel(expression.slice(opener + 1, -1))) {
    const argumentRoles = evaluateRoles(argument, lookup, state)
    if (argumentRoles == null) return null
    for (const role of argumentRoles) pushUnique(roles, role)
  }
  return roles
}

// The expression a `const name = ...` declaration assigns, or null.
function constantExpressionIn(text, name) {
  const declaration = new RegExp(`\\b(?:const|let)\\s+${escapeRegex(name)}\\s*(?::[^=]+)?=(?!>)\\s*`)
  const match = declaration.exec(text)
  return match ? expressionAt(text, match.index + match[0].length) : null
}

// What a zero-argument helper returns: `const name = () => expr`, `() => { return expr }`, or
// `function name() { return expr }`. Null when there's no such helper.
function helperReturnIn(text, name) {
  const escaped = escapeRegex(name)
  const arrow = new RegExp(
    `\\b(?:const|let)\\s+${escaped}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?\\(\\s*\\)\\s*(?::[^=]+)?=>\\s*`,
  )
  const declaration = new RegExp(`\\bfunction\\s+${escaped}\\s*\\(\\s*\\)\\s*(?::[^{]+)?\\{`)
  const arrowMatch = arrow.exec(text)
  if (arrowMatch) {
    const bodyStart = arrowMatch.index + arrowMatch[0].length
    if (text[bodyStart] !== '{') return expressionAt(text, bodyStart)
    return returnedExpression(text, bodyStart)
  }
  const declarationMatch = declaration.exec(text)
  return declarationMatch
    ? returnedExpression(text, declarationMatch.index + declarationMatch[0].length - 1)
    : null
}

function returnedExpression(text, bodyOpenIndex) {
  const body = text.slice(bodyOpenIndex, closingBraceEnd(text, bodyOpenIndex))
  const returnMatch = /\breturn\s+/.exec(body)
  return returnMatch ? expressionAt(body, returnMatch.index + returnMatch[0].length) : null
}

// Where `name` comes from when this file imports or re-exports it: the specifier and the name it
// has in that module.
function bindingSource(text, name) {
  for (const [, bindings, specifier] of text.matchAll(NAMED_BINDINGS)) {
    for (const binding of bindings.split(',')) {
      const [sourceName, localName = sourceName] = binding
        .trim()
        .split(/\s+as\s+/)
        .map((part) => part.trim())
      if (localName === name) return { specifier, sourceName }
    }
  }
  return null
}

// A lookup for role names and zero-argument helpers used in a router file: declared in the file,
// or imported from another one through named, renamed and `export *` re-exports. Without
// fromFile/resolve only the router file itself is searched.
export function roleConstantLookup(text, fromFile, resolve) {
  const visited = new Set()
  const followable = Boolean(fromFile && resolve)

  const rolesFor = (file, fileText, name, isCall, state) => {
    const key = `${file}\u0000${name}\u0000${isCall}`
    if (visited.has(key) || visited.size >= MAX_ROLE_LOOKUPS) return null
    visited.add(key)
    const expression = isCall ? helperReturnIn(fileText, name) : constantExpressionIn(fileText, name)
    if (expression != null) {
      const inThisFile = (innerName, innerIsCall) => rolesFor(file, fileText, innerName, innerIsCall, state)
      return evaluateRoles(expression, inThisFile, state)
    }
    if (!followable) return null
    const source = bindingSource(fileText, name)
    if (source) return rolesInModule(file, source.specifier, source.sourceName, isCall, state)
    for (const [, specifier] of fileText.matchAll(STAR_EXPORT)) {
      const roles = rolesInModule(file, specifier, name, isCall, state)
      if (roles) return roles
    }
    return null
  }

  const rolesInModule = (fromPath, specifier, name, isCall, state) => {
    const target = resolve(fromPath, specifier)
    return target ? rolesFor(target, readFile(target), name, isCall, state) : null
  }

  // Resolves one route expression; a fresh visited set each time, so routes don't block each other.
  return (expression) => {
    visited.clear()
    const state = { unresolved: false }
    const lookup = (name, isCall) => rolesFor(fromFile, text, name, isCall, state)
    const roles = evaluateRoles(expression, lookup, state)
    return { roles: roles || [], unresolved: state.unresolved }
  }
}

// Every role in every roles attribute (necessary and sufficient), in order, without repeats, plus
// the expressions that couldn't be read statically.
function rolesIn(texts, resolveExpression) {
  const roles = []
  const unresolvedRoles = []
  for (const text of texts) {
    for (const match of text.matchAll(ROUTE_ROLES)) {
      const expression = expressionAt(text, match.index + match[0].length)
      const result = resolveExpression(expression)
      for (const role of result.roles) pushUnique(roles, role)
      if (result.unresolved) pushUnique(unresolvedRoles, expression)
    }
  }
  return { roles, unresolvedRoles }
}

// One route per `element` anchor, with the path and roles of the same route object or tag.
export const parseRoutes = (text, resolveRoles = roleConstantLookup(text)) => {
  const routes = []
  for (const elementMatch of text.matchAll(ROUTE_ELEMENT)) {
    const elementStart = elementMatch.index + elementMatch[0].length
    const { tags, end } = walkJsxElement(text, elementStart)
    const component = screenComponentOf(tags)
    if (!component) continue
    const route = enclosingRoute(text, elementMatch.index)
    const routeText = route ? routeOwnText(text, route, { start: elementStart, end }) : ''
    // Roles can sit on the route itself or on a guard wrapping the screen inside `element`.
    const { roles, unresolvedRoles } = rolesIn([routeText, text.slice(elementStart, end)], resolveRoles)
    routes.push({ component, path: routeText.match(ROUTE_PATH)?.[1] ?? null, roles, unresolvedRoles })
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
// `unresolvedRoles` collects role expressions that couldn't be read statically, for the log.
function screensFromRouters(routerFiles, resolve, unresolvedRoles = []) {
  const screenByComponent = new Map()
  for (const routerFile of routerFiles) {
    const text = readFile(routerFile)
    const specifierByName = importMap(text)
    for (const route of parseRoutes(text, roleConstantLookup(text, routerFile, resolve))) {
      for (const expression of route.unresolvedRoles) {
        unresolvedRoles.push({ file: routerFile, component: route.component, expression })
      }
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
  const unresolvedRoles = []
  let screens = screensFromRouters(routerFiles, resolve, unresolvedRoles)
  if (!screens.some((screen) => screen.file)) {
    method = 'folder'
    screens = screensFromFolders(srcDir, resolve)
  }

  const described = screens
    .map((screen) => describeScreen(repoDir, screen, resolve))
    .filter(carriesInformation)
  described.sort((a, b) => a.name.localeCompare(b.name))
  for (const { file, component, expression } of unresolvedRoles) {
    console.log(`    roles not resolved: ${component} (${relativePosix(repoDir, file)}): ${expression}`)
  }
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
