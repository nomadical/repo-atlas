import fs from 'node:fs'
import path from 'node:path'

import { ROOT, AUDIT } from './_paths.mjs'
import { repos } from './repos.mjs'
const REPOS = repos.feInOrg

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p,'utf8')) } catch { return null } }

const walk = (dir, acc=[]) => {
  let ents; try { ents = fs.readdirSync(dir,{withFileTypes:true}) } catch { return acc }
  for (const e of ents) {
    const p = path.join(dir,e.name)
    if (e.isDirectory()) {
      if (['node_modules','.git','dist','build','storybook-static','coverage','.yalc'].includes(e.name)) continue
      walk(p,acc)
    } else acc.push(p)
  }
  return acc
}

const purpose = (repoDir, pj) => {
  if (pj?.description) return { source:'package.json', text: pj.description }
  const rp = path.join(repoDir,'README.md')
  if (fs.existsSync(rp)) {
    const lines = fs.readFileSync(rp,'utf8').split('\n')
    // first non-empty heading text, else first non-empty sentence
    let heading=null, sentence=null
    for (const l of lines) {
      const t=l.trim()
      if (!t) continue
      if (!heading && /^#{1,6}\s+/.test(t)) { heading = t.replace(/^#{1,6}\s+/,'').trim(); continue }
      if (!sentence && !/^[#>!\-*`|]/.test(t) && !/^<!--/.test(t)) { sentence = t.replace(/\s+/g,' ').slice(0,200); break }
    }
    return { source:'README.md', text: sentence || heading || null }
  }
  return { source:null, text:null }
}

const parseCodeowners = (repoDir) => {
  const cands = ['CODEOWNERS','.github/CODEOWNERS','docs/CODEOWNERS']
  const found = cands.map(c=>path.join(repoDir,c)).find(p=>fs.existsSync(p))
  if (!found) return { present:false, file:null, rules:[], owners:[] }
  const lines = fs.readFileSync(found,'utf8').split('\n')
  const rules=[]; const owners=new Set()
  for (const raw of lines) {
    const l = raw.replace(/#.*$/,'').trim()
    if (!l) continue
    const parts = l.split(/\s+/)
    const pattern = parts[0]
    const own = parts.slice(1)
    own.forEach(o=>owners.add(o))
    rules.push({ pattern, owners: own })
  }
  return { present:true, file: path.relative(repoDir,found), rules, owners:[...owners].sort() }
}

const out = {}
for (const repo of REPOS) {
  const repoDir = path.join(ROOT,repo)
  const pj = readJson(path.join(repoDir,'package.json'))
  const files = walk(repoDir)
  const rel = files.map(f=>path.relative(repoDir,f))
  const count = (re)=> rel.filter(f=>re.test(f)).length
  const testFiles = count(/\.test\.[cm]?[jt]sx?$/)
  const specFiles = count(/\.spec\.[cm]?[jt]sx?$/)
  const stories = count(/\.stories\.[cm]?[jt]sx?$/)
  const snapshots = count(/\.snap$/)
  // coverage
  let coverage=null
  const covSummary = ['coverage/coverage-summary.json','coverage-summary.json','coverage/coverage-final.json']
    .map(c=>path.join(repoDir,c)).find(p=>fs.existsSync(p))
  if (covSummary) {
    const cs = readJson(covSummary)
    if (cs?.total) coverage = { lines: cs.total.lines?.pct ?? null, statements: cs.total.statements?.pct ?? null, source: path.relative(repoDir,covSummary) }
    else coverage = { lines:null, statements:null, source: path.relative(repoDir,covSummary), note:'present but no total block' }
  } else if (fs.existsSync(path.join(repoDir,'coverage'))) {
    coverage = { lines:null, statements:null, source:'coverage/', note:'dir exists, no summary json' }
  }
  // Playwright suites (e2e harnesses): a repo with a playwright config counts its .spec files
  // as Playwright specs rather than unit specs.
  const isPlaywright = ['playwright.config.ts','playwright.config.js','playwright.config.mjs']
    .some(c=>fs.existsSync(path.join(repoDir,c)))
  const playwright = isPlaywright ? specFiles : null
  out[repo] = {
    purpose: purpose(repoDir,pj),
    codeowners: parseCodeowners(repoDir),
    tests: { unitTest: testFiles, unitSpec: specFiles, unitTotal: testFiles+specFiles, stories, snapshots, playwrightSpecs: playwright, coverage },
  }
}
fs.writeFileSync(path.join(AUDIT,'scripts/extras-mid.json'), JSON.stringify(out,null,2))
for (const [r,v] of Object.entries(out)) console.log(r.padEnd(26), 'tests:',String(v.tests.unitTotal).padStart(4), 'stories:',String(v.tests.stories).padStart(4), 'CODEOWNERS:', v.codeowners.present?'yes':'NO')
