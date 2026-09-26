// Single source of truth for the repo list, derived from the clones themselves.
//
// Node/FE repos are every git checkout under ROOT with a package.json. Backends (Java build files,
// no package.json) are discovered separately for backend-scan.mjs. Org membership comes from each
// clone's own `remote.origin.url`, so it can't drift from reality.
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { ROOT, AUDIT, ORG, inOrg } from './_paths.mjs'

const REMOTE_TIMEOUT_MS = 5000
const GH_LIST_TIMEOUT_MS = 20000
// Same cap as github-inventory.mjs and regenerate.yml.
const ORG_REPO_LIMIT = 400
const FRONTEND_LANGUAGES = ['JavaScript', 'TypeScript']
const JAVA_BUILD_FILES = ['pom.xml', 'build.gradle', 'build.gradle.kts']

// This tooling repo has a package.json too, but is never a subject repo.
const SELF = path.basename(AUDIT)

const isGitRepo = (name) => fs.existsSync(path.join(ROOT, name, '.git'))
const hasFile = (name, file) => fs.existsSync(path.join(ROOT, name, file))

const dirNames = () => {
  try {
    return fs
      .readdirSync(ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

const isSubjectRepo = (name) => name !== SELF && isGitRepo(name)
const isNodeRepo = (name) => hasFile(name, 'package.json')
const hasJavaBuild = (name) => JAVA_BUILD_FILES.some((file) => hasFile(name, file))

// All cloned Node repos under ROOT, alphabetical.
export const discoverRepoFolders = () =>
  dirNames()
    .filter((name) => isSubjectRepo(name) && isNodeRepo(name))
    .sort()

// backend-scan.mjs scans the union of this set and the BACKEND_REPOS env (the CI clone list).
export const discoverBackendFolders = () =>
  dirNames()
    .filter((name) => isSubjectRepo(name) && !isNodeRepo(name) && hasJavaBuild(name))
    .sort()

// ssh remotes (git@github.com:org/x.git) are normalized to https.
const readRemote = (folder) => {
  try {
    const raw = execSync('git config --get remote.origin.url', {
      cwd: path.join(ROOT, folder),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: REMOTE_TIMEOUT_MS,
    }).trim()
    if (!raw) return null
    const sshMatch = raw.match(/^git@([^:]+):(.+)$/)
    return sshMatch ? `https://${sshMatch[1]}/${sshMatch[2]}` : raw
  } catch {
    return null
  }
}

const ALL = discoverRepoFolders()
const remotesByFolder = new Map(ALL.map((folder) => [folder, readRemote(folder)]))
export const remoteOf = (folder) => remotesByFolder.get(folder) ?? null

// No remote at all, or a remote outside GITHUB_ORG. With no org configured only the remote-less
// ones drop out.
export const OUTSIDE = ALL.filter((folder) => !inOrg(remotesByFolder.get(folder)))

const isInOrg = (folder) => !OUTSIDE.includes(folder)

// Per-step scopes, keyed by the pipeline step that uses them.
export const repos = {
  all: ALL, // gather-arch
  feInOrg: ALL.filter(isInOrg), // extras-gather
  // Module graphs grep src/, so repos without one (asset buckets, config-only, e2e-only) are skipped.
  moduleGraph: ALL.filter((folder) => isInOrg(folder) && hasFile(folder, 'src')),
  workflows: ALL.filter((folder) => remotesByFolder.get(folder)), // parse-workflows (needs a remote)
}

// FE-looking repos that exist on GITHUB_ORG but aren't cloned here. Best effort: needs `gh` and a
// configured org.
export const uncloned = () => {
  if (!ORG) return []
  try {
    const listing = execSync(`gh repo list ${ORG} --limit ${ORG_REPO_LIMIT} --json name,primaryLanguage`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GH_LIST_TIMEOUT_MS,
    })
    const orgRepos = JSON.parse(listing)
    if (orgRepos.length >= ORG_REPO_LIMIT) {
      console.warn(
        `repos: org listing hit the ${ORG_REPO_LIMIT}-repo cap — results may be truncated, raise the limit`,
      )
    }
    const cloned = new Set(ALL)
    return orgRepos
      .filter((repo) => FRONTEND_LANGUAGES.includes(repo.primaryLanguage?.name) && !cloned.has(repo.name))
      .map((repo) => repo.name)
  } catch {
    return []
  }
}
