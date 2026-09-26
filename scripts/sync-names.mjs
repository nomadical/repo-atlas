// Detects GitHub repo renames and deletions and keeps the curated data in sync.
//
// Collects every GitHub repo the pipeline relies on (local clone origins and inventory-extra.json
// repoExtras keys), asks the GitHub API for each one's canonical name (the API follows rename
// redirects), then:
//   - rewrites inventory-extra.json repoExtras keys to the canonical name
//   - optionally repoints local clone origins (ATLAS_FIX_REMOTES=1)
//   - writes name-drift.json, which assemble.mjs uses to fix its remotes map and to surface
//     renames/deletions in the pipeline-health popover
//
// Skipped when gh is missing or unauthenticated, and when name-drift.json is under an hour old
// unless ATLAS_SYNC=force; ATLAS_SYNC=0 disables it.
import fs from 'node:fs'
import path from 'node:path'
import { execFile, execSync } from 'node:child_process'
import { promisify } from 'node:util'

import { AUDIT, ROOT, ORG } from './_paths.mjs'

const OUT = path.join(AUDIT, 'name-drift.json')
const EXTRA = path.join(AUDIT, 'inventory-extra.json')
const execFileAsync = promisify(execFile)
const MAX_AGE_MS = 60 * 60 * 1000
const MS_PER_MINUTE = 60000
const GH_MAX_BUFFER = 1024 * 1024
const AUTH_ERROR_PATTERN = /404|401|HTTP 4/
const WHOAMI_ARGS = ['api', 'user', '--jq', '{login: .login}']

const exitIfDisabledOrFresh = () => {
  if (process.env.ATLAS_SYNC === '0') {
    console.log('sync-names: disabled (ATLAS_SYNC=0)')
    process.exit(0)
  }
  if (process.env.ATLAS_SYNC === 'force' || !fs.existsSync(OUT)) return
  const ageMs = Date.now() - fs.statSync(OUT).mtimeMs
  if (ageMs >= MAX_AGE_MS) return
  console.log(
    `sync-names: name-drift.json is ${Math.round(ageMs / MS_PER_MINUTE)}min old, skipping (ATLAS_SYNC=force to refresh)`,
  )
  process.exit(0)
}

exitIfDisabledOrFresh()

// ---- gh auth ---------------------------------------------------------------------------------
// A scoped-down GITHUB_TOKEN env var (e.g. packages-only) shadows the keyring login and 404s on
// private repos, so on an auth error we retry via the keyring and stick with it once it works.
let ghEnv = { ...process.env }

const withoutEnvToken = (env) => {
  const { GITHUB_TOKEN: _envToken, ...rest } = env
  return rest
}

const runGh = async (args, env) => {
  const { stdout } = await execFileAsync('gh', args, { env, maxBuffer: GH_MAX_BUFFER })
  return JSON.parse(stdout)
}

const gh = async (args) => {
  try {
    return await runGh(args, ghEnv)
  } catch (error) {
    const message = String(error.stderr || error.message || '')
    if (!ghEnv.GITHUB_TOKEN || !AUTH_ERROR_PATTERN.test(message)) throw error
    const keyringEnv = withoutEnvToken(ghEnv)
    const result = await runGh(args, keyringEnv)
    ghEnv = keyringEnv
    return result
  }
}

const ensureGhAuth = async () => {
  try {
    await gh(WHOAMI_ARGS)
    return
  } catch {}
  try {
    ghEnv = withoutEnvToken(ghEnv)
    await gh(WHOAMI_ARGS)
  } catch {
    console.log('sync-names: gh CLI not available or not logged in — skipping')
    process.exit(0)
  }
}

await ensureGhAuth()

// The repo segment allows dots (md.kb is a legal repo name); the anchored optional .git still strips.
const parseRepoUrl = (url) => {
  const match = String(url || '').match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  return match ? `${match[1]}/${match[2]}` : null
}

// ---- Collect every GitHub URL the pipeline depends on ----------------------------------------
const sources = new Map() // lowercased 'owner/name' -> { full, foundIn: Set }

const addUrl = (url, where) => {
  const full = parseRepoUrl(url)
  if (!full) return
  const key = full.toLowerCase()
  if (!sources.has(key)) sources.set(key, { full, foundIn: new Set() })
  sources.get(key).foundIn.add(where)
}

const readOrigin = (dir) =>
  execSync('git remote get-url origin', {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

// A plain object on purpose: its (integer-keys-first) order decides the order of remoteFixes.
const collectCloneOrigins = () => {
  const originByFolder = {}
  for (const folder of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, folder)
    try {
      if (!fs.existsSync(path.join(dir, '.git'))) continue
      const url = readOrigin(dir)
      originByFolder[folder] = url
      addUrl(url, `clone:${folder}`)
    } catch {}
  }
  return originByFolder
}

const readInventoryExtra = () => {
  try {
    return JSON.parse(fs.readFileSync(EXTRA, 'utf8'))
  } catch {
    return null
  }
}

const cloneOrigins = collectCloneOrigins()
const inventoryExtra = readInventoryExtra()
for (const repoName of Object.keys(inventoryExtra?.repoExtras || {})) {
  addUrl(`https://github.com/${ORG}/${repoName}`, 'inventory-extra')
}

// ---- Resolve canonical names -----------------------------------------------------------------
const renames = []
const missing = []

const resolveCanonicalNames = async () => {
  for (const [key, source] of sources) {
    let canonical
    try {
      canonical = await gh([
        'api',
        `repos/${source.full}`,
        '--jq',
        '{full_name: .full_name, html_url: .html_url}',
      ])
    } catch {
      missing.push({ repo: source.full, foundIn: [...source.foundIn] })
      continue
    }
    if (canonical.full_name.toLowerCase() === key) continue
    renames.push({
      from: source.full,
      to: canonical.full_name,
      url: canonical.html_url,
      foundIn: [...source.foundIn],
    })
  }
}

console.log(
  `sync-names: checking ${sources.size} GitHub repos (gh as ${ghEnv.GITHUB_TOKEN ? 'env token' : 'keyring'})`,
)
await resolveCanonicalNames()

// ---- Apply: inventory-extra.json repoExtras keys follow renames ------------------------------
const repoOf = (fullName) => fullName.split('/')[1]

// Fields already under the new key win over the ones carried from the old key.
const renameRepoExtrasKeys = (repoExtras) => {
  let updated = false
  for (const rename of renames) {
    const oldKey = repoOf(rename.from)
    const newKey = repoOf(rename.to)
    if (!repoExtras[oldKey] || oldKey === newKey) continue
    repoExtras[newKey] = { ...repoExtras[oldKey], ...repoExtras[newKey] }
    delete repoExtras[oldKey]
    updated = true
  }
  return updated
}

let extraUpdated = false
if (inventoryExtra?.repoExtras && renames.length) {
  extraUpdated = renameRepoExtrasKeys(inventoryExtra.repoExtras)
  if (extraUpdated) {
    fs.writeFileSync(EXTRA, JSON.stringify(inventoryExtra, null, 2))
    console.log('sync-names: renamed inventory-extra.json repoExtras keys to canonical names')
  }
}

// ---- Apply (opt-in): repoint local clone origins ---------------------------------------------
const findRename = (url) => {
  const full = parseRepoUrl(url)
  if (!full) return undefined
  return renames.find((rename) => rename.from.toLowerCase() === full.toLowerCase())
}

const fixCloneRemotes = () => {
  const fixes = []
  for (const [folder, url] of Object.entries(cloneOrigins)) {
    const rename = findRename(url)
    if (!rename) continue
    try {
      execSync(`git remote set-url origin ${rename.url}.git`, {
        cwd: path.join(ROOT, folder),
        stdio: 'ignore',
      })
      fixes.push(`${folder}: origin → ${rename.url}`)
    } catch {}
  }
  return fixes
}

const remoteFixes = process.env.ATLAS_FIX_REMOTES === '1' ? fixCloneRemotes() : []

const checkedCount = sources.size
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      checked: checkedCount,
      renames,
      missing,
      extraUpdated,
      remoteFixes,
    },
    null,
    2,
  ),
)
const remoteFixesNote = remoteFixes.length ? `, remotes fixed: ${remoteFixes.length}` : ''
console.log(
  `wrote name-drift.json; checked: ${checkedCount}, renames: ${renames.length}, missing: ${missing.length}${remoteFixesNote}`,
)
