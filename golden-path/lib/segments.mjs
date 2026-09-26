/* Five groups, a repository in exactly one, so the counts always total the estate.

   Two orders on purpose: the array is READING order, `rank` is RESOLUTION order for a repository
   that fits several. Archived wins over everything — a dead repository is not a compliance question
   whatever its topics say — and Applicable is last, being what survives every other test. */
import { asOfDate } from './decision-log.mjs'
import { inScope } from './rules.mjs'

export const SEGMENTS = [
  {
    k: 'applicable',
    rank: 5,
    label: 'Applicable',
    hint: 'Live, classified, governed by the Golden Path',
    is: () => true,
  },
  {
    k: 'excluded',
    rank: 2,
    label: 'Excluded',
    hint: 'Curated as not applicable as a whole',
    is: (row, decisionLog, asOf) => !!asOfDate((decisionLog.excluded || {})[row.repository], asOf),
  },
  {
    k: 'out-of-scope',
    rank: 4,
    label: 'Out of scope',
    hint: 'Firmware, data, hardware, tests, infrastructure',
    is: (row) => !inScope(row),
  },
  {
    k: 'unclassified',
    rank: 3,
    label: 'Unclassified',
    hint: 'No type-* topic, so no rule can apply',
    is: (row) => row.type === 'Unclassified',
  },
  {
    k: 'archived',
    rank: 1,
    label: 'Archived',
    hint: 'Archived on GitHub, counted here whatever else they are',
    is: (row) => !!row.archived,
  },
]

const BY_RESOLUTION_ORDER = [...SEGMENTS].sort((a, b) => a.rank - b.rank)

export const segmentOf = (row, decisionLog = {}, asOf) =>
  BY_RESOLUTION_ORDER.find((segment) => segment.is(row, decisionLog, asOf)).k

// Counts per segment over a set of rows. Absolute by design: this is the axis they measure.
export function segmentCounts(rows, decisionLog, asOf) {
  const counts = {}
  for (const row of rows) {
    const segment = segmentOf(row, decisionLog, asOf)
    counts[segment] = (counts[segment] || 0) + 1
  }
  return counts
}
