// Keeps real estate data out of a repo whose committed data is meant to stay the demo. With
// config.json `demoDataOrg` set, the tracked pipeline outputs must describe that org and only
// the components it contains; a local `npm run regenerate` rewrites them with real data, and this
// stops that data from being committed. Forks that commit their own data remove `demoDataOrg`,
// which turns the check off.
//
//   node scripts/check-demo-data.mjs            check the working tree (CI)
//   node scripts/check-demo-data.mjs --staged   check what is about to be committed (pre-commit hook)
//   node scripts/check-demo-data.mjs --warn     after regenerate: explain, but never fail
//
// findRealData() is pure (file contents -> problems) so it can be unit-tested.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUDIT } from './_paths.mjs'

// Outputs that carry an `org` field naming the estate they describe.
export const ORG_FILES = ['fe-architecture.json', 'fe-architecture-extras.json', 'github-meta.json']
// Outputs without one, checked by the component names they mention.
export const NAME_FILES = ['backend-tooling.json', 'name-drift.json']
export const DATA_FILES = [...ORG_FILES, ...NAME_FILES]

// Every component, repo and backend name the demo architecture knows about.
function demoNames(architecture) {
  const names = new Set()
  for (const repo of architecture?.repos || []) names.add(repo.folder)
  for (const entry of architecture?.inventory || []) names.add(entry.name)
  for (const backend of architecture?.backendTopology?.backends || []) {
    for (const alias of [backend.id, backend.repo, backend.label, backend.invAlias]) names.add(alias)
  }
  names.delete(undefined)
  return names
}

// Repo/component names a name-only file mentions.
function namesIn(file, content) {
  if (file === 'backend-tooling.json')
    return [...Object.keys(content?.scanned || {}), ...(content?.missing || [])]
  const names = []
  for (const key of ['renames', 'missing', 'remoteFixes']) {
    for (const entry of content?.[key] || []) {
      if (typeof entry === 'string') names.push(entry)
      else if (entry && typeof entry === 'object')
        names.push(...Object.values(entry).filter((v) => typeof v === 'string'))
    }
  }
  return names
}

// `contents` maps file name -> parsed JSON (missing files are skipped). Returns human-readable problems.
export function findRealData(contents, demoOrg) {
  if (!demoOrg) return []
  const problems = []
  for (const file of ORG_FILES) {
    if (!(file in contents)) continue
    const org = contents[file]?.org
    if (org !== demoOrg) problems.push(`${file} describes org "${org ?? ''}", not the demo org "${demoOrg}"`)
  }
  const known = demoNames(contents['fe-architecture.json'])
  for (const file of NAME_FILES) {
    if (!(file in contents)) continue
    const unknown = [...new Set(namesIn(file, contents[file]))].filter((name) => !known.has(name))
    if (unknown.length)
      problems.push(`${file} mentions components outside the demo: ${unknown.slice(0, 5).join(', ')}`)
  }
  return problems
}

const readJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function readStaged(file) {
  try {
    return execFileSync('git', ['show', `:${file}`], {
      cwd: AUDIT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null // not tracked or staged
  }
}

function readWorkingTree(file) {
  const fullPath = path.join(AUDIT, file)
  return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : null
}

function main() {
  const staged = process.argv.includes('--staged')
  const warnOnly = process.argv.includes('--warn')
  const demoOrg = readJson(fs.readFileSync(path.join(AUDIT, 'config.json'), 'utf8'))?.demoDataOrg
  if (!demoOrg) return
  const contents = {}
  for (const file of DATA_FILES) {
    const text = staged ? readStaged(file) : readWorkingTree(file)
    if (text != null) contents[file] = readJson(text)
  }
  const problems = findRealData(contents, demoOrg)
  if (!problems.length) return
  const where = staged ? 'The staged' : 'The'
  console.error(`\n${where} data files no longer hold the ${demoOrg} demo (config.json demoDataOrg):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('A fork that should commit its own data: remove demoDataOrg from config.json.')
  // Last two lines on purpose: the dev server's Regenerate log shows only the tail.
  console.error("Real estate data: don't commit these files, this repo is public.")
  console.error(`Restore the demo: git checkout -- ${DATA_FILES.join(' ')}`)
  if (!warnOnly) process.exitCode = 1
}

// Run only when invoked directly, not when imported by a test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
