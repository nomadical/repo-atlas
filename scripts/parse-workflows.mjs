import fs from 'node:fs'
import path from 'node:path'

import { ROOT, AUDIT } from './_paths.mjs'
import { repos } from './repos.mjs'
const REPOS = repos.workflows

const ENVS = ['dev','test','pre','prod','demo','poc']

const detectTarget = (txt) => {
  const t = []
  if (/static[_-]?web[_-]?app|staticwebapp|swa_/i.test(txt)) t.push('Azure Static Web App')
  if (/blob|az storage blob|storage account|web\.core\.windows\.net|\$web/i.test(txt)) t.push('Azure Blob ($web static site)')
  if (/front[_ -]?door|afd|cdn|purge/i.test(txt)) t.push('Azure Front Door/CDN purge')
  if (/docker|container|acr\.io|azurecr|ghcr\.io|registry/i.test(txt)) t.push('Container image')
  if (/forge deploy|@forge/i.test(txt)) t.push('Atlassian Forge')
  if (/npm publish|yalc|registry\.npmjs|github packages|GITHUB_TOKEN.*publish/i.test(txt)) t.push('npm package publish')
  if (/azure\/webapps-deploy|app service|azure\/functions/i.test(txt)) t.push('Azure App Service/Functions')
  return [...new Set(t)]
}

const extractBranches = (txt) => {
  const branches = new Set()
  const lines = txt.split('\n')
  for (let i=0;i<lines.length;i++){
    // `branches:` only — a `branches-ignore:` list is the branches a deploy does NOT run on
    if (/^\s*branches:/.test(lines[i])) {
      const inline = lines[i].match(/\[([^\]]*)\]/)
      if (inline) inline[1].split(',').forEach(b=>branches.add(b.trim().replace(/['"]/g,'')))
      for (let j=i+1;j<lines.length;j++){
        const m = lines[j].match(/^\s*-\s*(.+)$/)
        if (m) branches.add(m[1].trim().replace(/['"]/g,''))
        else if (/^\s*\w/.test(lines[j])) break
      }
    }
  }
  return [...branches].filter(Boolean)
}

const extractTriggers = (txt) => {
  const trig = []
  for (const t of ['push','pull_request','workflow_dispatch','workflow_call','schedule','release']) {
    const re = new RegExp(`^\\s*${t}:`, 'm')
    if (re.test(txt)) trig.push(t)
  }
  return trig
}

const out = {}
for (const repo of REPOS) {
  const dir = path.join(ROOT, repo, '.github', 'workflows')
  if (!fs.existsSync(dir)) { out[repo] = []; continue }
  const files = fs.readdirSync(dir).filter(f=>/\.ya?ml$/.test(f))
  out[repo] = files.map(f => {
    const txt = fs.readFileSync(path.join(dir,f),'utf8')
    const lower = txt.toLowerCase()
    const isDeploy = /deploy|publish|release|blob|forge deploy|webapps-deploy/i.test(txt) && !/gitleaks|add_labels|docs-check/i.test(f)
    const envsFound = ENVS.filter(e => new RegExp(`\\b${e}\\b`).test(lower))
    return {
      file: f,
      triggers: extractTriggers(txt),
      branches: extractBranches(txt),
      deploys: isDeploy,
      environments: isDeploy ? envsFound : [],
      target: isDeploy ? detectTarget(txt) : [],
    }
  })
}
fs.writeFileSync(path.join(AUDIT,'scripts/workflows-out.json'), JSON.stringify(out,null,2))
console.log('done')
