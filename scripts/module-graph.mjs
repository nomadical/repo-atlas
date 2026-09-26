import fs from 'node:fs'
import path from 'node:path'

import { ROOT, AUDIT } from './_paths.mjs'
import { repos } from './repos.mjs'

// How many folder levels below src/ make up one graph node (src/<folder>).
const FOLDER_DEPTH = 1
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist'])
const EDGE_SEPARATOR = ' -> '
const IMPORT_PATTERN =
  /(?:import\s[^'"]*?from\s*|import\s*|export\s[^'"]*?from\s*|require\(\s*)['"]([^'"]+)['"]/g
// Path aliases that all point at src/.
const SRC_ALIAS_PATTERN = /^@src\/|^@\/|^~\//

const isSourceFile = (name) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts')

const listSourceFiles = (dir, found = []) => {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) listSourceFiles(entryPath, found)
    } else if (isSourceFile(entry.name)) {
      found.push(entryPath)
    }
  }
  return found
}

// Maps a repo-relative path to its graph node, or null when it is outside src/.
const toFolder = (pathFromRepo) => {
  const segments = pathFromRepo.split('/')
  if (segments[0] !== 'src') return null
  const lastSegment = segments[segments.length - 1]
  const dirSegments = /\.[a-z]+$/.test(lastSegment) ? segments.slice(0, -1) : segments.slice()
  if (dirSegments.length <= 1) return 'src'
  return dirSegments.slice(0, 1 + FOLDER_DEPTH).join('/')
}

const listTopFolders = (srcDir) =>
  new Set(
    fs
      .readdirSync(srcDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  )

// Resolves an extension-less import path the way a bundler would; null when no file matches.
const makeResolver = (knownFiles) => (pathWithoutExt) => {
  for (const ext of SOURCE_EXTENSIONS) {
    if (knownFiles.has(pathWithoutExt + ext)) return pathWithoutExt + ext
    const indexFile = pathWithoutExt + '/index' + ext
    if (knownFiles.has(indexFile)) return indexFile
  }
  if (knownFiles.has(pathWithoutExt)) return pathWithoutExt
  return null
}

// Returns the repo-relative import target, or null for a package import.
const importTarget = (specifier, importingFile, topFolders) => {
  if (specifier.startsWith('.')) return path.normalize(path.join(path.dirname(importingFile), specifier))
  if (specifier.startsWith('src/')) return specifier
  if (SRC_ALIAS_PATTERN.test(specifier)) return 'src/' + specifier.replace(SRC_ALIAS_PATTERN, '')
  // Bare specifiers that name a src/ top folder come from a baseUrl of src/.
  if (topFolders.has(specifier.split('/')[0])) return 'src/' + specifier
  return null
}

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const collectCrossFolderEdges = (repoDir, files, topFolders) => {
  const resolve = makeResolver(new Set(files.map((file) => path.relative(repoDir, file))))
  const edges = new Set()
  for (const file of files) {
    const relativeFile = path.relative(repoDir, file)
    const fromFolder = toFolder(relativeFile)
    if (!fromFolder) continue
    const text = readText(file)
    if (text === null) continue
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const target = importTarget(match[1], relativeFile, topFolders)
      if (target === null) continue
      const toFolderName = toFolder(resolve(target) || target)
      if (!toFolderName || toFolderName === fromFolder) continue
      edges.add(fromFolder + EDGE_SEPARATOR + toFolderName)
    }
  }
  return [...edges].sort().map((edge) => edge.split(EDGE_SEPARATOR))
}

const buildRepoGraph = (repo) => {
  const repoDir = path.join(ROOT, repo)
  const srcDir = path.join(repoDir, 'src')
  if (!fs.existsSync(srcDir)) return { method: 'grep', error: 'no src', crossFolderEdges: 0, edges: [] }
  const topFolders = listTopFolders(srcDir)
  const files = listSourceFiles(srcDir)
  const edges = collectCrossFolderEdges(repoDir, files, topFolders)
  return {
    method: 'grep',
    crossFolderEdges: edges.length,
    srcFiles: files.length,
    topFolders: [...topFolders].sort(),
    edges,
  }
}

const graphsByRepo = {}
for (const repo of repos.moduleGraph) graphsByRepo[repo] = buildRepoGraph(repo)

fs.writeFileSync(path.join(AUDIT, 'scripts/modulegraph-out.json'), JSON.stringify(graphsByRepo, null, 2))
for (const [repo, graph] of Object.entries(graphsByRepo)) {
  console.log(repo, '->', graph.crossFolderEdges, 'edges,', graph.srcFiles || 0, 'files')
}
