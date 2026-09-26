// Folder-level dependency graph via dependency-cruiser, for the frontends where it can resolve
// TypeScript paths and aliases. Writes scripts/depcruise-out.json.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { ROOT, AUDIT } from './_paths.mjs'
import { repos } from './repos.mjs'

const MAX_OUTPUT_BYTES = 1024 * 1024 * 256
const REPO_COLUMN_WIDTH = 26
const MAX_STORED_ERROR_LENGTH = 200
const MAX_LOGGED_ERROR_LENGTH = 120
const EDGE_SEPARATOR = ' -> '

// Derived, not hardcoded: any discovered FE repo with a local typescript install qualifies. The
// rest keep the grep-based graph from the main pipeline.
const resolvableRepos = repos.feInOrg.filter((repo) =>
  fs.existsSync(path.join(ROOT, repo, 'node_modules', 'typescript')),
)

const CONFIG = `module.exports = {
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { extensions: ['.ts','.tsx','.js','.jsx','.json'] },
    includeOnly: '^src',
  },
}
`
const configPath = path.join(os.tmpdir(), 'dc-accurate.cjs')
fs.writeFileSync(configPath, CONFIG)

// "src/a/b/file.ts" -> "src/a"; files directly under src/ map to "src"; outside src/ -> null.
function topFolder(modulePath) {
  const segments = modulePath.split('/')
  if (segments[0] !== 'src') return null
  if (segments.length <= 1) return 'src'
  const lastSegment = segments[segments.length - 1]
  const dirSegments = /\.[a-z]+$/.test(lastSegment) ? segments.slice(0, -1) : segments
  return dirSegments.length <= 1 ? 'src' : dirSegments.slice(0, 2).join('/')
}

function runDepcruise(repoDir) {
  const raw = execSync(
    `npx --yes dependency-cruiser@18 --config ${configPath} --output-type json "src/**/*.{ts,tsx,js,jsx}"`,
    {
      cwd: repoDir,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  )
  return JSON.parse(raw)
}

const isLocalSource = (resolved) =>
  resolved && resolved.startsWith('src') && !resolved.includes('node_modules')

function crossFolderGraph(modules) {
  const edgeKeys = new Set()
  let resolvedDeps = 0
  for (const module of modules) {
    const from = topFolder(module.source)
    if (!from) continue
    for (const dependency of module.dependencies || []) {
      if (!isLocalSource(dependency.resolved)) continue
      resolvedDeps++
      const to = topFolder(dependency.resolved)
      if (to && to !== from) edgeKeys.add(from + EDGE_SEPARATOR + to)
    }
  }
  const edges = [...edgeKeys].sort().map((key) => key.split(EDGE_SEPARATOR))
  return { resolvedDeps, edges }
}

function analyzeRepo(repo) {
  const cruise = runDepcruise(path.join(ROOT, repo))
  const { resolvedDeps, edges } = crossFolderGraph(cruise.modules)
  console.log(
    repo.padEnd(REPO_COLUMN_WIDTH),
    'depcruise OK modules=' + cruise.modules.length,
    'edges=' + edges.length,
  )
  return {
    method: 'depcruise',
    tsResolved: true,
    modules: cruise.modules.length,
    resolvedDeps,
    crossFolderEdges: edges.length,
    edges,
  }
}

const result = {}
for (const repo of resolvableRepos) {
  try {
    result[repo] = analyzeRepo(repo)
  } catch (error) {
    const message = String(error.message || error)
    result[repo] = { method: 'depcruise-failed', error: message.slice(0, MAX_STORED_ERROR_LENGTH) }
    console.log(repo.padEnd(REPO_COLUMN_WIDTH), 'FAILED', message.slice(0, MAX_LOGGED_ERROR_LENGTH))
  }
}
fs.writeFileSync(path.join(AUDIT, 'scripts/depcruise-out.json'), JSON.stringify(result, null, 2))
