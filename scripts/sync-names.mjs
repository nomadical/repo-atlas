// Detects GitHub repo renames/deletions and keeps the curated data in sync.
//
// Collects every GitHub repo the pipeline relies on (local clone origins +
// inventory-extra.json repoExtras keys), asks the GitHub API for each repo's
// canonical name (the API follows rename redirects), then:
//   - rewrites inventory-extra.json repoExtras keys to the canonical name
//   - optionally repoints local clone origins (ATLAS_FIX_REMOTES=1)
//   - writes name-drift.json, which assemble.mjs uses to fix its remotes map at
//     runtime and to surface renames/deletions in the pipeline-health popover
//
// Degrades gracefully: skipped when gh is missing/unauthenticated, and when
// name-drift.json is fresh (<1h) unless ATLAS_SYNC=force; disable with ATLAS_SYNC=0.
import fs from 'node:fs'
import path from 'node:path'
import { execFile, execSync } from 'node:child_process'
import { promisify } from 'node:util'

import { AUDIT, ROOT, ORG } from './_paths.mjs'

const OUT = path.join(AUDIT, 'name-drift.json')
const EXTRA = path.join(AUDIT, 'inventory-extra.json')
const execFileP = promisify(execFile)
const MAX_AGE_MS = 60 * 60 * 1000

if (process.env.ATLAS_SYNC === '0') { console.log('sync-names: disabled (ATLAS_SYNC=0)'); process.exit(0) }
if (process.env.ATLAS_SYNC !== 'force' && fs.existsSync(OUT)) {
  const age = Date.now() - fs.statSync(OUT).mtimeMs
  if (age < MAX_AGE_MS) { console.log(`sync-names: name-drift.json is ${Math.round(age / 60000)}min old, skipping (ATLAS_SYNC=force to refresh)`); process.exit(0) }
}

// gh auth: a scoped-down GITHUB_TOKEN env var (e.g. a packages-only token) shadows the
// keyring login and 404s on private repos — fall back to the keyring when that happens.
let ghEnv = { ...process.env }
const gh = async (args) => {
  try { return JSON.parse((await execFileP('gh', args, { env: ghEnv, maxBuffer: 1024 * 1024 })).stdout) }
  catch (e) {
    const msg = String(e.stderr || e.message || '')
    if (ghEnv.GITHUB_TOKEN && /404|401|HTTP 4/.test(msg)) {
      const { GITHUB_TOKEN, ...rest } = ghEnv
      const out = JSON.parse((await execFileP('gh', args, { env: rest, maxBuffer: 1024 * 1024 })).stdout)
      ghEnv = rest // keyring worked — keep using it
      return out
    }
    throw e
  }
}

try { await gh(['api', 'user', '--jq', '{login: .login}']) } catch {
  try { // retry probe without the env token before giving up
    const { GITHUB_TOKEN, ...rest } = ghEnv; ghEnv = rest
    await gh(['api', 'user', '--jq', '{login: .login}'])
  } catch { console.log('sync-names: gh CLI not available or not logged in — skipping'); process.exit(0) }
}

const parseRepoUrl = (url) => {
  // repo segment allows dots (md.kb is a legal repo name); the anchored optional .git still strips
  const m = String(url || '').match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  return m ? `${m[1]}/${m[2]}` : null
}

// ---- collect every github URL the pipeline depends on -------------------------------
const sources = {} // 'owner/name' (lowercase) -> { full, foundIn: Set }
const addUrl = (url, where) => {
  const full = parseRepoUrl(url)
  if (!full) return
  const key = full.toLowerCase()
  sources[key] = sources[key] || { full, foundIn: new Set() }
  sources[key].foundIn.add(where)
}

const cloneOrigins = {} // folder -> current origin url
for (const folder of fs.readdirSync(ROOT)) {
  const dir = path.join(ROOT, folder)
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) continue
    const url = execSync('git remote get-url origin', { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    cloneOrigins[folder] = url
    addUrl(url, `clone:${folder}`)
  } catch {}
}
let extra = null
try { extra = JSON.parse(fs.readFileSync(EXTRA, 'utf8')) } catch {}
for (const repoName of Object.keys(extra?.repoExtras || {})) addUrl(`https://github.com/${ORG}/${repoName}`, 'inventory-extra')

// ---- resolve canonical names (API follows rename redirects) -------------------------
const renames = [], missing = []
const keys = Object.keys(sources)
console.log(`sync-names: checking ${keys.length} GitHub repos (gh as ${ghEnv.GITHUB_TOKEN ? 'env token' : 'keyring'})`)
for (const key of keys) {
  const s = sources[key]
  let canonical
  try { canonical = await gh(['api', `repos/${s.full}`, '--jq', '{full_name: .full_name, html_url: .html_url}']) }
  catch { missing.push({ repo: s.full, foundIn: [...s.foundIn] }); continue }
  if (canonical.full_name.toLowerCase() !== key) {
    renames.push({ from: s.full, to: canonical.full_name, url: canonical.html_url, foundIn: [...s.foundIn] })
  }
}

// ---- apply: inventory-extra.json repoExtras keys follow renames ----------------------
let extraUpdated = false
if (extra?.repoExtras && renames.length) {
  for (const r of renames) {
    const oldKey = r.from.split('/')[1], newKey = r.to.split('/')[1]
    if (!extra.repoExtras[oldKey] || oldKey === newKey) continue
    extra.repoExtras[newKey] = { ...extra.repoExtras[oldKey], ...(extra.repoExtras[newKey] || {}) }
    delete extra.repoExtras[oldKey]
    extraUpdated = true
  }
  if (extraUpdated) { fs.writeFileSync(EXTRA, JSON.stringify(extra, null, 2)); console.log('sync-names: renamed inventory-extra.json repoExtras keys to canonical names') }
}

// ---- apply (opt-in): repoint local clone origins -------------------------------------
const remoteFixes = []
if (process.env.ATLAS_FIX_REMOTES === '1') {
  for (const [folder, url] of Object.entries(cloneOrigins)) {
    const full = parseRepoUrl(url)
    const r = full && renames.find((x) => x.from.toLowerCase() === full.toLowerCase())
    if (!r) continue
    try {
      execSync(`git remote set-url origin ${r.url}.git`, { cwd: path.join(ROOT, folder), stdio: 'ignore' })
      remoteFixes.push(`${folder}: origin → ${r.url}`)
    } catch {}
  }
}

fs.writeFileSync(OUT, JSON.stringify({
  checkedAt: new Date().toISOString(),
  checked: keys.length,
  renames, missing, extraUpdated, remoteFixes,
}, null, 2))
console.log(`wrote name-drift.json; checked: ${keys.length}, renames: ${renames.length}, missing: ${missing.length}${remoteFixes.length ? `, remotes fixed: ${remoteFixes.length}` : ''}`)
