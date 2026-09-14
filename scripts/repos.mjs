// Single source of truth for the repo list — everything here is DERIVED from the clones
// themselves (no hardcoded repo arrays).
//
// The base set is AUTO-DISCOVERED: every sibling checkout under ROOT that is a git repo
// with a package.json (i.e. a Node/FE project). Backends (Java: pom.xml/build.gradle, no
// package.json) are discovered separately (discoverBackendFolders) for backend-scan.mjs.
//
// Classification is read from each clone's own git remote:
//   - remoteOf(folder): the actual `remote.origin.url` (normalized to https), so the org
//     membership and repo links can't drift from reality.
//   - OUTSIDE: repos whose remote is missing or outside GITHUB_ORG (out of scope for the
//     org-only enrichment steps, but still gathered so they can be flagged inOrg=false).
//   - moduleGraph scope: repos that actually have a src/ dir (the module graph greps src/).
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { ROOT, AUDIT, ORG, inOrg } from './_paths.mjs'

// never treat this tooling repo itself as a subject repo (it also has a package.json)
const SELF = path.basename(AUDIT)

const isGitRepo = (name) => fs.existsSync(path.join(ROOT, name, '.git'))
const has = (name, file) => fs.existsSync(path.join(ROOT, name, file))

const dirNames = () => {
  try {
    return fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch { return [] }
}

// All cloned Node repos under ROOT, alphabetical.
export const discoverRepoFolders = () =>
  dirNames().filter((name) => name !== SELF && isGitRepo(name) && has(name, 'package.json')).sort()

// Cloned backend repos: git checkout with Java build files and no package.json. backend-scan.mjs
// scans the union of this set and the BACKEND_REPOS env (the canonical CI list, used for cloning).
export const discoverBackendFolders = () =>
  dirNames()
    .filter((name) => name !== SELF && isGitRepo(name) && !has(name, 'package.json')
      && (has(name, 'pom.xml') || has(name, 'build.gradle') || has(name, 'build.gradle.kts')))
    .sort()

// remote.origin.url per repo, normalized to https (ssh git@github.com:org/x.git → https URL).
const readRemote = (folder) => {
  try {
    const raw = execSync('git config --get remote.origin.url', {
      cwd: path.join(ROOT, folder), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim()
    if (!raw) return null
    const m = raw.match(/^git@([^:]+):(.+)$/)
    return m ? `https://${m[1]}/${m[2]}` : raw
  } catch { return null }
}

const ALL = discoverRepoFolders()
const REMOTES = Object.fromEntries(ALL.map((f) => [f, readRemote(f)]))
export const remoteOf = (folder) => REMOTES[folder] ?? null

// Out-of-scope repos: no remote at all, or a remote outside GITHUB_ORG (see _paths.mjs `inOrg`;
// with no org configured only the remote-less ones drop out).
export const OUTSIDE = ALL.filter((f) => !inOrg(REMOTES[f]))

// Per-step scopes (all derived from the single discovered set).
export const repos = {
  all: ALL,                                                        // gather-arch
  feInOrg: ALL.filter((r) => !OUTSIDE.includes(r)),                 // extras-gather
  // module graphs grep src/ — repos without one (asset buckets, config-only, e2e-only) are skipped
  moduleGraph: ALL.filter((r) => !OUTSIDE.includes(r) && has(r, 'src')),
  workflows: ALL.filter((r) => REMOTES[r]),                        // parse-workflows (needs a remote)
}

// Best-effort org cross-check: FE-looking repos that exist on GITHUB_ORG but aren't cloned here
// (so the pipeline can't see them). Requires `gh` and a configured org; skipped without either.
export const uncloned = () => {
  if (!ORG) return []
  try {
    // same cap as github-inventory.mjs / regenerate.yml (they were 400 while this was 300)
    const out = execSync(`gh repo list ${ORG} --limit 400 --json name,primaryLanguage`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 })
    const org = JSON.parse(out)
    if (org.length >= 400) console.warn(`repos: org listing hit the 400-repo cap — results may be truncated, raise the limit`)
    const cloned = new Set(ALL)
    return org
      .filter((r) => ['JavaScript', 'TypeScript'].includes(r.primaryLanguage?.name) && !cloned.has(r.name))
      .map((r) => r.name)
  } catch { return [] }
}
