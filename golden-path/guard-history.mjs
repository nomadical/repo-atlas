// Refuses a history.json that regressed — fewer nights, a night that lost most of its
// repositories, dates out of order or in the future — so a bad night fails the run instead of being
// published. Everything found is fatal: the file is append-only, so it cannot be corrected later.
//
// `resetAt` marks a deliberate reset, and the shrink checks then look only at nights from that date
// onward — an intentional reset must not trip the guard meant to catch an accidental one.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rowsAfter } from './lib/history.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const MAX_RUN_SHRINK = 0.9

const sinceReset = (nights, resetAt) => (resetAt ? nights.filter((night) => night.date >= resetAt) : nights)

// config.json `guard.minGoldenPathRows`, or 0 when it is unset or unreadable.
function minimumRows() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(REPO, 'config.json'), 'utf8'))
    return config.guard?.minGoldenPathRows ?? 0
  } catch {
    return 0
  }
}

// Unique and strictly increasing, none in the future.
function checkDates(nights, errors) {
  const today = new Date().toISOString().slice(0, 10)
  for (let i = 1; i < nights.length; i++) {
    const previous = nights[i - 1].date
    const current = nights[i].date
    if (!(current > previous)) {
      errors.push(`dates not strictly increasing at index ${i}: ${previous} -> ${current}`)
    }
  }
  const lastDate = nights[nights.length - 1].date
  if (lastDate > today) errors.push(`last night "${lastDate}" is in the future`)
}

// The latest run didn't collapse against the one before.
function checkRunShrink(relevant, lastCount, errors) {
  if (relevant.length <= 1) return
  const previousCount = Object.keys(rowsAfter(relevant.slice(0, -1))).length
  if (previousCount && lastCount < previousCount * MAX_RUN_SHRINK) {
    errors.push(`the latest run has ${lastCount} repos, down from ${previousCount} (>10% drop)`)
  }
}

// A slow bleed (~9%/night) passes the night-over-night check forever, so there is also an absolute
// floor. Set config.json `guard.minGoldenPathRows` well below your real row count but far above any
// plausible legitimate decline. Unset it is 0 and nothing catches a slow bleed, so set it once the
// history has a few weeks.
function checkFloor(lastCount, errors) {
  const floor = minimumRows()
  if (lastCount < floor) {
    errors.push(
      `only ${lastCount} repos in the latest state (floor ${floor}) — slow-bleed or scan regression`,
    )
  }
}

const isWellFormedRow = (name, row) =>
  !!row &&
  typeof row.repository === 'string' &&
  typeof row.type === 'string' &&
  Array.isArray(row.applications) &&
  row.repository === name

// Counts alone can't see every field flipping to junk.
function checkRowShape(lastRows, errors) {
  const badRows = Object.entries(lastRows).filter(([name, row]) => !isWellFormedRow(name, row)).length
  if (badRows) {
    errors.push(`${badRows} rows in the latest state are malformed (repository/type/applications shape)`)
  }
}

// The number of nights didn't shrink against the git-committed version.
function checkAgainstCommitted(relevant, prevHistory, resetAt, errors) {
  if (!prevHistory) return
  const committedRelevant = sinceReset(prevHistory.history || [], resetAt)
  if (relevant.length < committedRelevant.length) {
    errors.push(`${relevant.length} nights since reset, down from ${committedRelevant.length} in git`)
  }
}

export function validate(history, prevHistory = null) {
  const errors = []
  if (!Array.isArray(history.history) || !history.history.length) {
    errors.push('history.history is missing or empty')
    return errors
  }
  const nights = history.history
  const relevant = sinceReset(nights, history.resetAt)
  const lastRows = rowsAfter(relevant)
  const lastCount = Object.keys(lastRows).length

  checkDates(nights, errors)
  checkRunShrink(relevant, lastCount, errors)
  checkFloor(lastCount, errors)
  checkRowShape(lastRows, errors)
  checkAgainstCommitted(relevant, prevHistory, history.resetAt, errors)
  return errors
}

function readCommittedHistory() {
  try {
    const committed = execFileSync('git', ['show', 'HEAD:golden-path/history.json'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return JSON.parse(committed)
  } catch {
    // Not in git yet: nothing to compare against.
    return null
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  const file = process.argv[2] || path.join(HERE, 'history.json')
  const history = JSON.parse(fs.readFileSync(file, 'utf8'))
  const errors = validate(history, readCommittedHistory())
  if (errors.length) {
    console.error(`✗ history guard FAILED — not committing. ${history.history.length} nights.`)
    for (const error of errors) console.error(`  • ${error}`)
    process.exit(1)
  }
  console.log(`✓ history guard passed — ${history.history.length} nights`)
}
