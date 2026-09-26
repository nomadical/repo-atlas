/* Each night lists only what changed since the night before, so a night is rebuilt by applying
   entries in order. */
import { CHECKS, cellsOf } from './rules.mjs'

// A null value means the repository is gone that night.
function applyChanges(rows, changed) {
  for (const [repository, row] of Object.entries(changed)) {
    if (row === null) delete rows[repository]
    else rows[repository] = row
  }
}

// -> [{ d, t, rows }], oldest first. Rows are shared between nights; nobody mutates one.
export function expandHistory(file) {
  const current = {}
  return (file.history || []).map(({ date, changed }) => {
    applyChanges(current, changed)
    return { d: date, t: Date.parse(date), rows: { ...current } }
  })
}

// The end state only — same fold, so the guard and the page cannot disagree.
export const rowsAfter = (nights) => {
  const rows = {}
  for (const { changed } of nights) applyChanges(rows, changed)
  return rows
}

// Only what moved; a repository that vanished is recorded as null.
export function diffRows(previousRows, rows) {
  const changed = {}
  for (const repository of Object.keys(rows)) {
    const moved = JSON.stringify(previousRows[repository]) !== JSON.stringify(rows[repository])
    if (moved) changed[repository] = rows[repository]
  }
  for (const repository of Object.keys(previousRows)) {
    if (!rows[repository]) changed[repository] = null
  }
  return changed
}

// One pass over a night, read by both charts. `keep` is the caller's filter.
export function statsOn(night, { decisionLog = {}, keep = () => true } = {}) {
  const totals = { ok: 0, dev: 0, bad: 0, unk: 0 }
  // One entry per check even when no row survives the filter: the charts index this by column.
  const perCheck = CHECKS.map(() => ({ met: 0, applicable: 0 }))
  for (const row of Object.values(night.rows)) {
    if (!keep(row, night.d)) continue
    cellsOf(row, decisionLog, night.d).forEach((cell, checkIndex) => {
      if (cell.s === 'na') return
      totals[cell.s]++
      perCheck[checkIndex].applicable++
      if (cell.s === 'ok' || cell.s === 'dev') perCheck[checkIndex].met++
    })
  }
  return { t: night.t, ...totals, perCheck }
}
