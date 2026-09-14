/* Each night lists only what changed since the night before, so a night is rebuilt by applying
   entries in order. */
import { CHECKS, cellsOf } from './rules.mjs'

// -> [{ d, t, rows }], oldest first. Rows are shared between nights; nobody mutates one.
export function expandHistory(file) {
  const cur = {}
  return (file.history || []).map(({ date, changed }) => {
    for (const k of Object.keys(changed)) changed[k] === null ? delete cur[k] : (cur[k] = changed[k])
    return { d:date, t:Date.parse(date), rows:{ ...cur } }
  })
}

// The end state only — same fold, so the guard and the page cannot disagree.
export const rowsAfter = (nights) => {
  const acc = {}
  for (const { changed } of nights) for (const [k, v] of Object.entries(changed)) { if (v === null) delete acc[k]; else acc[k] = v }
  return acc
}

// Only what moved; a repository that vanished is recorded as null.
export function diffRows(prev, rows) {
  const changed = {}
  for (const k of Object.keys(rows)) if (JSON.stringify(prev[k]) !== JSON.stringify(rows[k])) changed[k] = rows[k]
  for (const k of Object.keys(prev)) if (!rows[k]) changed[k] = null
  return changed
}

// One pass over a night, read by both charts. `keep` is the caller's filter.
export function statsOn(night, { decisionLog = {}, keep = () => true } = {}) {
  const totals = { ok:0, dev:0, bad:0, unk:0 }
  // One entry per check even when no row survives the filter: the charts index this by column.
  const perCheck = CHECKS.map(() => ({ met:0, applicable:0 }))
  for (const u of Object.values(night.rows)) {
    if (!keep(u, night.d)) continue
    cellsOf(u, decisionLog, night.d).forEach((c, i) => {
      if (c.s === 'na') return
      totals[c.s]++
      perCheck[i].applicable++
      if (c.s === 'ok' || c.s === 'dev') perCheck[i].met++
    })
  }
  return { t:night.t, ...totals, perCheck }
}
