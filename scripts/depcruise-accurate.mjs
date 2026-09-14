import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { ROOT, AUDIT } from './_paths.mjs'
import { repos } from './repos.mjs'
// repos where depcruise can resolve TS/aliases — DERIVED (repos.mjs principle: no hardcoded repo
// arrays): any discovered FE repo with a local typescript install qualifies; the rest keep the
// grep graph from the main pipeline.
const RESOLVABLE = repos.feInOrg.filter((r) => fs.existsSync(path.join(ROOT, r, 'node_modules', 'typescript')))

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
const cfgPath = path.join(os.tmpdir(), 'dc-accurate.cjs')
fs.writeFileSync(cfgPath, CONFIG)

const toTop = (p) => {
  const segs = p.split('/')
  if (segs[0] !== 'src') return null
  if (segs.length <= 1) return 'src'
  const last = segs[segs.length-1]
  const dirSegs = /\.[a-z]+$/.test(last) ? segs.slice(0,-1) : segs
  return dirSegs.length <= 1 ? 'src' : dirSegs.slice(0,2).join('/')
}

const result = {}
for (const repo of RESOLVABLE) {
  const repoDir = path.join(ROOT, repo)
  try {
    const raw = execSync(
      `npx --yes dependency-cruiser@18 --config ${cfgPath} --output-type json "src/**/*.{ts,tsx,js,jsx}"`,
      { cwd: repoDir, encoding: 'utf8', maxBuffer: 1024*1024*256, stdio: ['ignore','pipe','ignore'] }
    )
    const j = JSON.parse(raw)
    const edgeSet = new Set()
    let crossFileDeps = 0
    for (const m of j.modules) {
      const from = toTop(m.source)
      if (!from) continue
      for (const d of (m.dependencies||[])) {
        const r = d.resolved
        if (!r || !r.startsWith('src') || r.includes('node_modules')) continue
        crossFileDeps++
        const to = toTop(r)
        if (!to || to === from) continue
        edgeSet.add(from+' -> '+to)
      }
    }
    const edges = [...edgeSet].sort().map(e=>e.split(' -> '))
    result[repo] = { method:'depcruise', tsResolved:true, modules:j.modules.length, resolvedDeps:crossFileDeps, crossFolderEdges:edges.length, edges }
    console.log(repo.padEnd(26),'depcruise OK modules='+j.modules.length,'edges='+edges.length)
  } catch (e) {
    result[repo] = { method:'depcruise-failed', error:String(e.message||e).slice(0,200) }
    console.log(repo.padEnd(26),'FAILED', String(e.message||e).slice(0,120))
  }
}
fs.writeFileSync(path.join(AUDIT,'scripts/depcruise-out.json'), JSON.stringify(result,null,2))
