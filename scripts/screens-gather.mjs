// Per-FE-client SCREEN extraction with best-effort endpoint attribution.
//
// For each FE client repo (repos.feInOrg), this:
//   1. finds router files (*Router*.tsx + files using <Route>/createBrowserRouter),
//   2. parses route entries — pairing each `element: <Comp/>` / `element={<Comp/>}` with its nearest
//      string-literal `path` and any necessary/sufficient roles (covers RouteItem[] arrays, <Route>
//      JSX, and createBrowserRouter object routes),
//   3. resolves each screen component back to an on-disk file (relative + tsconfig path-alias),
//   4. attributes endpoints by BFS-walking that component's local import graph and collecting
//      use<Name>Endpoints('path') literals (shared with gather-arch via lib/endpoints.mjs).
// Repos with no parseable routers fall back to folder convention (src/pages|screens|views/*).
//
// Output: scripts/screens-out.json — { perRepo: { <folder>: { method, routerFiles, screens:[...] } } }.
// Heuristic by design (see plan): widely-shared hooks over-attribute; dynamic endpoint strings are
// missed. Accuracy can be improved later with a curated override file.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ROOT, AUDIT, maybeFetch } from './_paths.mjs'
import { repos } from './repos.mjs'
import { extractEndpointsFromText, extractApiCallsFromText } from './lib/endpoints.mjs'

const EXTS = ['.tsx', '.ts', '.jsx', '.js']
const SKIP_COMPONENTS = new Set(['Navigate', 'Outlet', 'Fragment', 'Suspense', 'Routes', 'Route', 'RouterProvider'])
const MAX_BFS_FILES = 600 // per-screen import-graph walk cap
const MAX_BFS_DEPTH = 8
const PATH_FWD = 600 // chars after an `element` to look for its path
const PATH_BACK = 200 // chars before an `element` to look for its path (path-first JSX)

const readFile = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const rel = (repoDir, abs) => path.relative(repoDir, abs).split(path.sep).join('/')

// Walk a repo's src/ tree, returning every source file (skips node_modules, dist, tests dirs).
const walkSrc = (dir, acc = []) => {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'build', '.git', 'coverage', '__snapshots__'].includes(e.name)) continue
      walkSrc(p, acc)
    } else if (EXTS.includes(path.extname(e.name))) {
      acc.push(p)
    }
  }
  return acc
}

// Tolerant tsconfig read (strips // and /* */ comments + trailing commas) -> { baseUrl, paths }.
const readTsPaths = (repoDir) => {
  for (const name of ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json']) {
    const raw = readFile(path.join(repoDir, name))
    if (!raw) continue
    const cleaned = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1')
    try {
      const j = JSON.parse(cleaned)
      const co = j.compilerOptions || {}
      return { baseUrl: co.baseUrl || '.', paths: co.paths || {} }
    } catch { /* try next */ }
  }
  return { baseUrl: '.', paths: {} }
}

// Resolve a specifier (relative or alias) imported from `fromFile` to an on-disk file inside the repo.
// Returns an absolute path or null (external packages, node_modules, unresolved aliases -> null).
const makeResolver = (repoDir, ts) => {
  const tryFile = (base) => {
    for (const ext of EXTS) if (fs.existsSync(base + ext)) return base + ext
    for (const ext of EXTS) { const idx = path.join(base, 'index' + ext); if (fs.existsSync(idx)) return idx }
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base
    return null
  }
  const baseDir = path.join(repoDir, ts.baseUrl || '.')
  // alias candidates from tsconfig paths (e.g. "*": ["./src/*"], "@/*": ["src/*"])
  const aliasCandidates = (spec) => {
    const out = []
    for (const [pattern, targets] of Object.entries(ts.paths)) {
      const star = pattern.indexOf('*')
      if (star < 0) { if (pattern === spec) for (const t of targets) out.push(path.join(baseDir, t)); continue }
      const pre = pattern.slice(0, star)
      const post = pattern.slice(star + 1)
      if (spec.startsWith(pre) && spec.endsWith(post)) {
        const mid = spec.slice(pre.length, spec.length - post.length)
        for (const t of targets) out.push(path.join(baseDir, t.replace('*', mid)))
      }
    }
    return out
  }
  return (fromFile, spec) => {
    if (!spec || spec.startsWith('node:')) return null
    if (spec.startsWith('.')) return tryFile(path.resolve(path.dirname(fromFile), spec))
    // bare specifier: try tsconfig aliases, then baseUrl-relative (covers "*":["./src/*"])
    for (const cand of aliasCandidates(spec)) { const f = tryFile(cand); if (f) return f }
    const f = tryFile(path.join(baseDir, spec))
    if (f && f.startsWith(repoDir)) return f
    return null // external package
  }
}

// import/export specifiers in a file's text (static + dynamic import()).
const importSpecs = (text) => {
  const out = new Set()
  const res = [
    /(?:import|export)\s+[^'"]*?\s+from\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g, // side-effect import
    /import\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import
  ]
  for (const re of res) { let m; while ((m = re.exec(text))) out.add(m[1]) }
  return [...out]
}

// Map a component identifier -> import specifier, from a router file's imports.
export const importMap = (text) => {
  const map = {}
  // default + namespace: import Foo from 'x' / import * as Foo from 'x'
  let m
  const def = /import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s*['"]([^'"]+)['"]/g
  while ((m = def.exec(text))) map[m[1]] = m[2]
  // named: import { A, B as C } from 'x'
  const named = /import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s+from\s*['"]([^'"]+)['"]/g
  while ((m = named.exec(text))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) map[name] = m[2]
    }
  }
  // lazy/dynamic component bindings: const X = lazy(() => import('spec')) (also React.lazy, loadable…)
  const lazyRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = lazyRe.exec(text))) map[m[1]] = m[2]
  return map
}

// Parse route entries from a router file's text: nearest path + roles for each `element` anchor.
export const parseRoutes = (text) => {
  const routes = []
  const elementRe = /element\s*[:=]\s*\{?\s*(<[\s\S]{0,200}?>)/g
  let m
  while ((m = elementRe.exec(text))) {
    // first non-skip component in the element value
    const comps = [...m[1].matchAll(/<([A-Z][\w$]*)/g)].map((x) => x[1])
    const component = comps.find((c) => !SKIP_COMPONENTS.has(c))
    if (!component) continue
    const i = m.index
    const fwd = text.slice(i, i + PATH_FWD)
    const back = text.slice(Math.max(0, i - PATH_BACK), i)
    const pathRe = /path\s*[:=]\s*['"]([^'"]+)['"]/g
    // element-first: nearest path *after* the element. path-first JSX (<Route path=… element=…>):
    // the *last* path before the element (closest), not an earlier sibling's.
    const fwdMatch = pathRe.exec(fwd)
    const backMatches = [...back.matchAll(/path\s*[:=]\s*['"]([^'"]+)['"]/g)]
    const pm = fwdMatch || (backMatches.length ? backMatches[backMatches.length - 1] : null)
    const rolesRaw = /(?:necessary|sufficient)Roles\s*[:=]\s*\[([^\]]*)\]/.exec(fwd)
    const roles = rolesRaw ? [...rolesRaw[1].matchAll(/\.([A-Za-z0-9_]+)|['"]([^'"]+)['"]/g)].map((x) => x[1] || x[2]).filter(Boolean) : []
    routes.push({ component, path: pm ? pm[1] : null, roles })
  }
  return routes
}

// Named imports a file pulls from the shared design system — the components/hooks/tokens a screen
// uses from it. Captures the *exported* name (before any `as` alias). The package list is
// config.json `uiPackages`, same as isUiPkg in graph.js; with none configured nothing matches.
const appConfig = (() => { try { return JSON.parse(fs.readFileSync(path.join(AUDIT, 'config.json'), 'utf8')) } catch { return {} } })()
const UI_PACKAGES = Array.isArray(appConfig.uiPackages) ? appConfig.uiPackages : []
const escapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const UI_IMPORT_RE = UI_PACKAGES.length
  ? new RegExp(`import\\s+(?:[A-Za-z0-9_$]+\\s*,\\s*)?\\{([^}]*)\\}\\s+from\\s*['"](?:${UI_PACKAGES.map(escapeRe).join('|')})['"]`, 'g')
  : null
export const extractUiComponents = (text, set = new Set()) => {
  if (!UI_IMPORT_RE) return set
  UI_IMPORT_RE.lastIndex = 0
  let m
  while ((m = UI_IMPORT_RE.exec(text))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim()
      if (name && /^[A-Za-z]/.test(name)) set.add(name)
    }
  }
  return set
}

// BFS a screen component's local import graph, unioning endpoints + design-system imports found.
const traceEndpoints = (startFile, resolve) => {
  const endpoints = new Set()
  const components = new Set()
  const seen = new Set([startFile])
  let frontier = [startFile]
  let scanned = 0
  for (let depth = 0; depth <= MAX_BFS_DEPTH && frontier.length && scanned < MAX_BFS_FILES; depth++) {
    const next = []
    for (const file of frontier) {
      if (scanned >= MAX_BFS_FILES) break
      scanned++
      const text = readFile(file)
      if (!text) continue
      extractEndpointsFromText(text, endpoints) // use*Endpoints('path') hooks
      extractApiCallsFromText(text, endpoints) // fetch/axios/.get/.post + template-URL paths
      extractUiComponents(text, components) // @framework/ui named imports
      for (const spec of importSpecs(text)) {
        const target = resolve(file, spec)
        if (target && !seen.has(target)) { seen.add(target); next.push(target) }
      }
    }
    frontier = next
  }
  return { endpoints: [...endpoints].sort(), components: [...components].sort(), filesScanned: scanned }
}

// Scan a whole screen directory subtree for endpoints. Used for folder-method screens, whose
// components often sit several levels below the dir (e.g. AddFlow/AddNewAsset/AddNewAsset.tsx) with
// no resolvable entry file — and whose repos frequently have no tsconfig aliases, so import-graph
// BFS stalls. The dir is the screen boundary, so scanning it directly is both simpler and complete.
const traceDir = (dir) => {
  const endpoints = new Set()
  const components = new Set()
  const files = walkSrc(dir).slice(0, MAX_BFS_FILES)
  for (const f of files) {
    const t = readFile(f)
    if (!t) continue
    extractEndpointsFromText(t, endpoints)
    extractApiCallsFromText(t, endpoints)
    extractUiComponents(t, components)
  }
  return { endpoints: [...endpoints].sort(), components: [...components].sort(), filesScanned: files.length }
}

// Humanize a path/component into a screen label.
const screenName = (component, routePath) => component || (routePath || '').replace(/^\//, '').split('/')[0] || 'screen'

const gatherRepo = (folder) => {
  const repoDir = path.join(ROOT, folder)
  const srcDir = path.join(repoDir, 'src')
  if (!fs.existsSync(srcDir)) return null
  maybeFetch(repoDir)
  const ts = readTsPaths(repoDir)
  const resolve = makeResolver(repoDir, ts)
  const allFiles = walkSrc(srcDir)

  // router files: *Router*.tsx, or any file using <Route/createBrowserRouter
  const routerFiles = allFiles.filter((f) => {
    if (/Router[\w]*\.[jt]sx?$/.test(path.basename(f))) return true
    const t = readFile(f)
    return /<Route[\s>]|createBrowserRouter|createRoutesFromElements/.test(t)
  })

  const byComponent = new Map() // component -> screen (merge multiple paths)
  for (const rf of routerFiles) {
    const text = readFile(rf)
    const imap = importMap(text)
    for (const r of parseRoutes(text)) {
      const spec = imap[r.component]
      const file = spec ? resolve(rf, spec) : null
      const key = r.component
      const existing = byComponent.get(key)
      if (existing) {
        if (r.path && !existing.paths.includes(r.path)) existing.paths.push(r.path)
        for (const role of r.roles) if (!existing.roles.includes(role)) existing.roles.push(role)
        if (!existing.file && file) existing.file = file
      } else {
        byComponent.set(key, { component: r.component, paths: r.path ? [r.path] : [], roles: [...r.roles], file })
      }
    }
  }

  let method = 'router'
  let screens = [...byComponent.values()]

  // fallback: folder convention when no router-derived screens with files
  if (!screens.some((s) => s.file)) {
    method = 'folder'
    screens = []
    for (const dirName of ['pages', 'screens', 'views']) {
      const base = path.join(srcDir, dirName)
      if (!fs.existsSync(base)) continue
      // resolve() takes dirname(fromFile), so anchor on a sentinel file *inside* base
      const anchor = path.join(base, 'index.tsx')
      for (const e of fs.readdirSync(base, { withFileTypes: true })) {
        const stem = path.basename(e.name, path.extname(e.name))
        if (e.isDirectory()) { const f = resolve(anchor, './' + e.name); screens.push({ component: e.name, paths: [], roles: [], file: f, dir: path.join(base, e.name) }) }
        // loose component files only: PascalCase .tsx/.jsx (skip utils/constants/index)
        else if (/\.[jt]sx$/.test(e.name) && /^[A-Z]/.test(stem)) { const f = resolve(anchor, './' + e.name); screens.push({ component: stem, paths: [], roles: [], file: f }) }
      }
    }
  }

  // attribute endpoints per screen: folder-method screens scan their whole dir subtree; router-method
  // screens BFS the resolved component's import graph.
  const out = []
  for (const s of screens) {
    const trace = s.dir ? traceDir(s.dir) : s.file ? traceEndpoints(s.file, resolve) : { endpoints: [], components: [], filesScanned: 0 }
    out.push({
      name: screenName(s.component, s.paths[0]),
      component: s.component,
      path: s.paths[0] || null,
      paths: s.paths,
      roles: s.roles,
      file: s.file ? rel(repoDir, s.file) : s.dir ? rel(repoDir, s.dir) + '/' : null,
      endpoints: trace.endpoints,
      components: trace.components || [],
      filesScanned: trace.filesScanned,
    })
  }
  // drop pure noise: a "screen" with no route path, no resolved file, and no endpoints carries nothing
  const kept = out.filter((s) => s.path || s.file || s.endpoints.length || s.components.length)
  kept.sort((a, b) => a.name.localeCompare(b.name))
  return { method, routerFiles: routerFiles.length, screens: kept }
}

// CLI: run the full extraction only when invoked directly (not when imported by a test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const perRepo = {}
  for (const folder of repos.feInOrg) {
    const r = gatherRepo(folder)
    if (!r) continue
    perRepo[folder] = r
    const withEp = r.screens.filter((s) => s.endpoints.length).length
    console.log(`  ${folder}: ${r.screens.length} screens (${r.method}), ${withEp} with endpoints`)
  }
  fs.writeFileSync(path.join(AUDIT, 'scripts/screens-out.json'), JSON.stringify({ perRepo }, null, 2))
  console.log('done; repos with screens:', Object.keys(perRepo).length)
}
