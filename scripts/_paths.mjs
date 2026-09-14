// Shared, portable paths for the data pipeline (no hardcoded machine paths).
//
//   AUDIT  -> this repo (repo-atlas/)             — where pipeline output is written
//   ROOT   -> the directory holding your clones   — where each repo is read from
//
// ROOT defaults to the parent of this repo (the usual ~/.../GitHub checkout layout) and
// can be overridden with ATLAS_REPOS_DIR for CI or non-standard checkouts.
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { execSync } from 'node:child_process'

export const AUDIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ROOT = process.env.ATLAS_REPOS_DIR || path.resolve(AUDIT, '..')

// GitHub org the pipeline scans (repo discovery, inventory topics, canonical remotes). Set
// GITHUB_ORG to scope the map to one org. Left unset, the pipeline does not filter by org: every
// cloned git repo with a remote is in scope, which is the useful default for a single-org checkout
// dir or a personal estate.
export const ORG = process.env.GITHUB_ORG || ''

// Does a remote URL belong to the configured org? With no GITHUB_ORG set, any remote counts —
// the pipeline still needs a remote (a repo with none is out of scope either way).
const ORG_RE = ORG ? new RegExp(`github\\.com[/:]${ORG}/`, 'i') : null
export const inOrg = (url) => (url ? (ORG_RE ? ORG_RE.test(url) : true) : false)

// Optionally refresh a repo's remote refs before reading (opt-in via ATLAS_FETCH=1).
// fetch only touches .git refs, never the working tree, so it is safe on dirty checkouts.
export const maybeFetch = (repoDir) => {
  if (process.env.ATLAS_FETCH !== '1') return
  try { execSync('git fetch --quiet --tags', { cwd: repoDir, stdio: 'ignore', timeout: 60000 }) } catch {}
}