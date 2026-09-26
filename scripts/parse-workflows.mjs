import fs from 'node:fs'
import path from 'node:path'

import { ROOT, AUDIT } from './_paths.mjs'
import { repos } from './repos.mjs'

const ENVIRONMENTS = ['dev', 'test', 'pre', 'prod', 'demo', 'poc']
const TRIGGERS = ['push', 'pull_request', 'workflow_dispatch', 'workflow_call', 'schedule', 'release']

// Checked in order; a workflow can match several targets.
const DEPLOY_TARGETS = [
  ['Azure Static Web App', /static[_-]?web[_-]?app|staticwebapp|swa_/i],
  ['Azure Blob ($web static site)', /blob|az storage blob|storage account|web\.core\.windows\.net|\$web/i],
  ['Azure Front Door/CDN purge', /front[_ -]?door|afd|cdn|purge/i],
  ['Container image', /docker|container|acr\.io|azurecr|ghcr\.io|registry/i],
  ['Atlassian Forge', /forge deploy|@forge/i],
  ['npm package publish', /npm publish|yalc|registry\.npmjs|github packages|GITHUB_TOKEN.*publish/i],
  ['Azure App Service/Functions', /azure\/webapps-deploy|app service|azure\/functions/i],
]

const DEPLOY_PATTERN = /deploy|publish|release|blob|forge deploy|webapps-deploy/i
const NON_DEPLOY_FILE_PATTERN = /gitleaks|add_labels|docs-check/i

const detectTargets = (text) =>
  DEPLOY_TARGETS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)

const unquote = (value) => value.trim().replace(/['"]/g, '')

// Handles both `branches: [a, b]` and a following `- a` list. Only `branches:` counts: a
// `branches-ignore:` list is the branches a deploy does NOT run on.
const extractBranches = (text) => {
  const branches = new Set()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*branches:/.test(lines[i])) continue
    const inlineList = lines[i].match(/\[([^\]]*)\]/)
    if (inlineList) {
      for (const branch of inlineList[1].split(',')) branches.add(unquote(branch))
    }
    for (let j = i + 1; j < lines.length; j++) {
      const listItem = lines[j].match(/^\s*-\s*(.+)$/)
      if (listItem) branches.add(unquote(listItem[1]))
      else if (/^\s*\w/.test(lines[j])) break
    }
  }
  return [...branches].filter(Boolean)
}

const extractTriggers = (text) => TRIGGERS.filter((trigger) => new RegExp(`^\\s*${trigger}:`, 'm').test(text))

const parseWorkflow = (dir, file) => {
  const text = fs.readFileSync(path.join(dir, file), 'utf8')
  const lowerText = text.toLowerCase()
  const deploys = DEPLOY_PATTERN.test(text) && !NON_DEPLOY_FILE_PATTERN.test(file)
  const environments = ENVIRONMENTS.filter((env) => new RegExp(`\\b${env}\\b`).test(lowerText))
  return {
    file,
    triggers: extractTriggers(text),
    branches: extractBranches(text),
    deploys,
    environments: deploys ? environments : [],
    target: deploys ? detectTargets(text) : [],
  }
}

const parseRepoWorkflows = (repo) => {
  const dir = path.join(ROOT, repo, '.github', 'workflows')
  if (!fs.existsSync(dir)) return []
  const workflowFiles = fs.readdirSync(dir).filter((file) => /\.ya?ml$/.test(file))
  return workflowFiles.map((file) => parseWorkflow(dir, file))
}

const workflowsByRepo = {}
for (const repo of repos.workflows) workflowsByRepo[repo] = parseRepoWorkflows(repo)

fs.writeFileSync(path.join(AUDIT, 'scripts/workflows-out.json'), JSON.stringify(workflowsByRepo, null, 2))
console.log('done')
