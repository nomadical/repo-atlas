import fs from 'node:fs'
import path from 'node:path'

import { ROOT, AUDIT } from './_paths.mjs'
import { repos } from './repos.mjs'
const REPOS = repos.moduleGraph

const walk = (dir, acc=[]) => {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
      walk(p, acc)
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      acc.push(p)
    }
  }
  return acc
}

const DEPTH = 1
const toFolder = (relFromRepo) => {
  const segs = relFromRepo.split('/')
  if (segs[0] !== 'src') return null
  const last = segs[segs.length-1]
  const segsDir = /\.[a-z]+$/.test(last) ? segs.slice(0, -1) : segs.slice()
  if (segsDir.length <= 1) return 'src'
  return segsDir.slice(0, 1 + DEPTH).join('/')
}

const importRe = /(?:import\s[^'"]*?from\s*|import\s*|export\s[^'"]*?from\s*|require\(\s*)['"]([^'"]+)['"]/g

const result = {}
for (const repo of REPOS) {
  const repoDir = path.join(ROOT, repo)
  const srcDir = path.join(repoDir, 'src')
  if (!fs.existsSync(srcDir)) { result[repo] = { method:'grep', error:'no src', crossFolderEdges:0, edges:[] }; continue }
  const topFolders = new Set(fs.readdirSync(srcDir, {withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name))
  const files = walk(srcDir)
  const fileSet = new Set(files.map(f => path.relative(repoDir, f)))
  const exists = (relNoExt) => {
    for (const ext of ['.ts','.tsx','.js','.jsx','.mjs','.cjs']) {
      if (fileSet.has(relNoExt+ext)) return relNoExt+ext
      if (fileSet.has(relNoExt+'/index'+ext)) return relNoExt+'/index'+ext
    }
    if (fileSet.has(relNoExt)) return relNoExt
    return null
  }
  const edgeSet = new Set()
  for (const file of files) {
    const relFile = path.relative(repoDir, file)
    const fromFolder = toFolder(relFile)
    if (!fromFolder) continue
    let txt
    try { txt = fs.readFileSync(file,'utf8') } catch { continue }
    let m
    importRe.lastIndex = 0
    while ((m = importRe.exec(txt))) {
      const spec = m[1]
      let targetRel = null
      if (spec.startsWith('.')) {
        const abs = path.normalize(path.join(path.dirname(relFile), spec))
        targetRel = exists(abs) || abs
      } else if (spec.startsWith('src/')) {
        targetRel = exists(spec) || spec
      } else if (spec.startsWith('@src/') || spec.startsWith('@/') || spec.startsWith('~/')) {
        const abs = 'src/' + spec.replace(/^@src\/|^@\/|^~\//, '')
        targetRel = exists(abs) || abs
      } else {
        const first = spec.split('/')[0]
        if (topFolders.has(first)) {
          const abs = 'src/'+spec
          targetRel = exists(abs) || abs
        } else {
          continue
        }
      }
      const dest = toFolder(targetRel)
      if (!dest) continue
      if (dest === fromFolder) continue
      edgeSet.add(fromFolder + ' -> ' + dest)
    }
  }
  const edges = [...edgeSet].sort().map(e => e.split(' -> '))
  result[repo] = { method:'grep', crossFolderEdges: edges.length, srcFiles: files.length, topFolders:[...topFolders].sort(), edges }
}

fs.writeFileSync(path.join(AUDIT,'scripts/modulegraph-out.json'), JSON.stringify(result,null,2))
for (const [r,v] of Object.entries(result)) console.log(r, '->', v.crossFolderEdges, 'edges,', v.srcFiles||0,'files')
