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

const sinceReset = (history, resetAt) => resetAt ? history.filter((h) => h.date >= resetAt) : history

export function validate(history, prevHistory = null) {
  const errors = []

  if (!Array.isArray(history.history) || !history.history.length) {
    errors.push('history.history is missing or empty')
    return errors
  }
  const nights = history.history
  const relevant = sinceReset(nights, history.resetAt)

  // ---- dates: unique and strictly increasing, none in the future -------------------------
  const today = new Date().toISOString().slice(0, 10)
  for (let i = 0; i < nights.length; i++) {
    if (i > 0 && !(nights[i].date > nights[i - 1].date)) errors.push(`dates not strictly increasing at index ${i}: ${nights[i - 1].date} -> ${nights[i].date}`)
  }
  const lastDate = nights[nights.length - 1].date
  if (lastDate > today) errors.push(`last night "${lastDate}" is in the future`)

  // ---- coverage: last night didn't collapse vs the night before --------------------------
  if (relevant.length > 1) {
    const prevCount = Object.keys(rowsAfter(relevant.slice(0, -1))).length
    const lastCount = Object.keys(rowsAfter(relevant)).length
    if (prevCount && lastCount < prevCount * 0.9) errors.push(`last night has ${lastCount} repos, down from ${prevCount} (>10% drop)`)
  }
  // ---- absolute floor: a slow bleed (~9%/night) passes the night-over-night check forever ----
  // Set config.json `guard.minGoldenPathRows` well below your real row count but far above any
  // plausible legitimate decline. Unset it is 0 — the night-over-night check above still catches a
  // sudden collapse, but nothing catches a slow bleed, so set it once the history has a few weeks.
  const MIN_ROWS = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(REPO, 'config.json'), 'utf8')).guard?.minGoldenPathRows ?? 0 } catch { return 0 }
  })()
  const lastRows = rowsAfter(relevant)
  const lastCount = Object.keys(lastRows).length
  if (lastCount < MIN_ROWS) errors.push(`only ${lastCount} repos in the latest state (floor ${MIN_ROWS}) — slow-bleed or scan regression`)

  // ---- content: rows must keep their shape (counts alone can't see every field flipping to junk)
  let badRows = 0
  for (const [name, r] of Object.entries(lastRows)) {
    if (!r || typeof r.repository !== 'string' || typeof r.type !== 'string' || !Array.isArray(r.applications)) badRows++
    else if (r.repository !== name) badRows++
  }
  if (badRows) errors.push(`${badRows} rows in the latest state are malformed (repository/type/applications shape)`)

  // ---- nights count didn't shrink vs the git-committed version ---------------------------
  if (prevHistory) {
    const prevRelevant = sinceReset(prevHistory.history || [], history.resetAt)
    if (relevant.length < prevRelevant.length) errors.push(`${relevant.length} nights since reset, down from ${prevRelevant.length} in git`)
  }

  return errors
}

// ---- CLI ------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] || path.join(HERE, 'history.json')
  const history = JSON.parse(fs.readFileSync(file, 'utf8'))

  let prevHistory = null
  try {
    prevHistory = JSON.parse(execFileSync('git', ['show', 'HEAD:golden-path/history.json'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch { /* not in git yet — nothing to compare against */ }

  const errors = validate(history, prevHistory)
  if (errors.length) {
    console.error(`✗ history guard FAILED — not committing. ${history.history.length} nights.`)
    for (const e of errors) console.error(`  • ${e}`)
    process.exit(1)
  }
  console.log(`✓ history guard passed — ${history.history.length} nights`)
}
