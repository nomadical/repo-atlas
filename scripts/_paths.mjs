// Shared, portable paths for the data pipeline (no hardcoded machine paths).
//
//   AUDIT -> this repo (repo-atlas/), where pipeline output is written
//   ROOT  -> the directory holding your clones, where each repo is read from
//
// ROOT defaults to the parent of this repo and can be overridden with ATLAS_REPOS_DIR.
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { execSync } from 'node:child_process'

const FETCH_TIMEOUT_MS = 60000

export const AUDIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ROOT = process.env.ATLAS_REPOS_DIR || path.resolve(AUDIT, '..')

// GitHub org the pipeline scans. Left unset, the pipeline does not filter by org: every cloned git
// repo with a remote is in scope.
export const ORG = process.env.GITHUB_ORG || ''

const ORG_REMOTE_PATTERN = ORG ? new RegExp(`github\\.com[/:]${ORG}/`, 'i') : null

// A repo with no remote is out of scope even when no org is configured.
export const inOrg = (url) => {
  if (!url) return false
  if (!ORG_REMOTE_PATTERN) return true
  return ORG_REMOTE_PATTERN.test(url)
}

// Opt-in via ATLAS_FETCH=1. fetch only touches .git refs, so it is safe on dirty checkouts.
export const maybeFetch = (repoDir) => {
  if (process.env.ATLAS_FETCH !== '1') return
  try {
    execSync('git fetch --quiet --tags', { cwd: repoDir, stdio: 'ignore', timeout: FETCH_TIMEOUT_MS })
  } catch {}
}
