// Evaluating one repository against the Golden Path. No DOM, no fetch — the screen and the tests
// call the same functions.
import { asOfDate } from './decision-log.mjs'

// Fallback when rules.json can't be read; setRules() replaces it (live binding). Every type is
// listed with no rules, which reads as "out of scope" — the honest answer when the standards
// document itself is missing. Put your real rules in golden-path/rules.json, not here.
export let RULES = {
  Service: {},
  Client: {},
  Library: {},
  Firmware: {},
  Data: {},
  Hardware: {},
  Tests: {},
  Infrastructure: {},
  Assets: {},
  // No `type-*` topic on GitHub: unclassified, not exempt.
  Unclassified: {},
}

// Which document the rules came from, so the page can say what it judged against.
export let SOURCE = null

// Missing `rules` keeps the fallback: no rules at all would read as "everything is out of scope".
export function setRules(file) {
  if (file?.rules && Object.keys(file.rules).length) RULES = file.rules
  SOURCE = file?.source || null
  return RULES
}

/* `absent` marks a conditional rule: explicit null from the scanner = N/A (out of the denominator),
   missing key = "could not tell" and still counts against the component. Logging/tracing
   deliberately lack it — see docs/goldenpath/todo.md. */
export const CHECKS = [
  { k: 'lang', name: 'Language', read: (row) => row.language },
  { k: 'fw', name: 'Framework', read: (row) => row.framework },
  {
    k: 'db',
    name: 'Database',
    read: (row) => row.database,
    absent: 'this component has no database',
  },
  { k: 'build', name: 'Build', read: (row) => row.buildTool },
  { k: 'log', name: 'Logging', read: (row) => row.logging },
  { k: 'trace', name: 'Tracing', read: (row) => row.tracing },
]

// Derived: a column reads "not collected" until the first night that carries it.
export let COLLECTED = { lang: true, fw: true, build: true, db: false, log: false, trace: false }

export function deriveCollected(rows) {
  const seen = { ...COLLECTED }
  for (const check of CHECKS) {
    if (seen[check.k]) continue
    seen[check.k] = rows.some((row) => check.read(row) !== undefined)
  }
  COLLECTED = seen
  return COLLECTED
}

const rulesFor = (row) => RULES[row.type] || {}

// In scope = the Golden Path claims at least one rule for this kind.
export const inScope = (row) => Object.keys(rulesFor(row)).length > 0

const RULE_ALTERNATIVES = ' / '
const VALUE_WORD_SEPARATORS = /[^a-z0-9.+#]+/

// Word boundaries, not substrings — `includes` let "Java" pass on "JavaScript".
// Only the first word of each alternative is compared.
function conforms(value, spec) {
  const words = String(value).toLowerCase().split(VALUE_WORD_SEPARATORS).filter(Boolean)
  return spec.split(RULE_ALTERNATIVES).some((alternative) => {
    const firstWord = alternative.toLowerCase().split(' ')[0]
    return words.includes(firstWord)
  })
}

function noRuleReason(row, check) {
  if (row.type === 'Unclassified') {
    return 'No type-* topic on the GitHub repository, so nobody has said which rules apply'
  }
  return `Golden Path defines no ${check.name.toLowerCase()} rule for a ${row.type.toLowerCase()}`
}

function cellOf(row, check, { approved, notApplicable }, asOf) {
  const spec = rulesFor(row)[check.k]
  if (!spec) return { s: 'na', reason: noRuleReason(row, check) }

  const curatedNotApplicable = asOfDate((notApplicable[row.repository] || {})[check.k], asOf)
  if (curatedNotApplicable) return { s: 'na', spec, audit: curatedNotApplicable, curated: true }
  if (!COLLECTED[check.k]) return { s: 'unk', spec }

  const value = check.read(row)
  if (value === null && check.absent) {
    return { s: 'na', spec, reason: `Scanned: ${check.absent}, so the rule has nothing to judge` }
  }
  if (value == null) return { s: 'unk', spec }
  if (conforms(value, spec)) return { s: 'ok', spec, v: value }

  const approval = asOfDate((approved[row.repository] || {})[check.k], asOf)
  if (approval) return { s: 'dev', spec, v: value, audit: approval }
  return { s: 'bad', spec, v: value }
}

// One row of cells: ok, dev (approved deviation), bad, unk (not scanned), na.
// `asOf` narrows curated decisions to the night being evaluated.
export function cellsOf(row, decisionLog = {}, asOf) {
  const { approved = {}, notApplicable = {}, excluded = {} } = decisionLog
  const exclusion = asOfDate(excluded[row.repository], asOf)
  if (exclusion) return CHECKS.map(() => ({ s: 'na', audit: exclusion, excluded: true }))
  return CHECKS.map((check) => cellOf(row, check, { approved, notApplicable }, asOf))
}

const isConforming = (cell) => cell.s === 'ok' || cell.s === 'dev'

// Not-scanned stays in the denominator: silence is not conformance.
export const totalOf = (cells) => {
  const applicable = cells.filter((cell) => cell.s !== 'na')
  return { met: applicable.filter(isConforming).length, of: applicable.length }
}
