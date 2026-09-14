// Evaluating one repository against the Golden Path. No DOM, no fetch — the screen and the tests
// call the same functions.
import { asOfDate } from './decision-log.mjs'

// Fallback when rules.json can't be read; setRules() replaces it (live binding). Every type is
// listed with no rules, which reads as "out of scope" — the honest answer when the standards
// document itself is missing. Put your real rules in golden-path/rules.json, not here.
export let RULES = {
  Service:{}, Client:{},
  Library:{}, Firmware:{}, Data:{}, Hardware:{}, Tests:{}, Infrastructure:{}, Assets:{},
  // No `type-*` topic on GitHub: unclassified, not exempt.
  Unclassified:{},
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
  { k:'lang',  name:'Language',  read:(u) => u.language },
  { k:'fw',    name:'Framework', read:(u) => u.framework },
  { k:'db',    name:'Database',  read:(u) => u.database, absent:'this component has no database' },
  { k:'build', name:'Build',     read:(u) => u.buildTool },
  { k:'log',   name:'Logging',   read:(u) => u.logging },
  { k:'trace', name:'Tracing',   read:(u) => u.tracing },
]

// Derived: a column reads "not collected" until the first night that carries it.
export let COLLECTED = { lang:true, fw:true, build:true, db:false, log:false, trace:false }

export function deriveCollected(rows) {
  const seen = { ...COLLECTED }
  for (const c of CHECKS) {
    if (seen[c.k]) continue
    seen[c.k] = rows.some((u) => c.read(u) !== undefined)
  }
  COLLECTED = seen
  return COLLECTED
}

// In scope = the Golden Path claims at least one rule for this kind.
export const inScope = (u) => Object.keys(RULES[u.type] || {}).length > 0

// Word boundaries, not substrings — `includes` let "Java" pass on "JavaScript".
// ' / ' in a rule is a list of alternatives.
function conforms(value, spec) {
  const words = String(value).toLowerCase().split(/[^a-z0-9.+#]+/).filter(Boolean)
  return spec.split(' / ').some((want) => {
    const first = want.toLowerCase().split(' ')[0]
    return words.includes(first)
  })
}

// One row of cells: ok, dev (approved deviation), bad, unk (not scanned), na.
// `asOf` narrows curated decisions to the night being evaluated.
export function cellsOf(u, decisionLog = {}, asOf) {
  const { approved = {}, notApplicable = {}, excluded = {} } = decisionLog
  const ex = asOfDate(excluded[u.repository], asOf)
  if (ex) return CHECKS.map(() => ({ s:'na', audit:ex, excluded:true }))
  return CHECKS.map((c) => {
    const spec = (RULES[u.type] || {})[c.k]
    if (!spec) return { s:'na', reason: u.type === 'Unclassified'
      ? 'No type-* topic on the GitHub repository, so nobody has said which rules apply'
      : `Golden Path defines no ${c.name.toLowerCase()} rule for a ${u.type.toLowerCase()}` }
    const custom = asOfDate((notApplicable[u.repository] || {})[c.k], asOf)
    if (custom) return { s:'na', spec, audit:custom, curated:true }
    if (!COLLECTED[c.k]) return { s:'unk', spec }
    const v = c.read(u)
    if (v === null && c.absent) return { s:'na', spec, reason:`Scanned: ${c.absent}, so the rule has nothing to judge` }
    if (v == null) return { s:'unk', spec }
    if (conforms(v, spec)) return { s:'ok', spec, v }
    const appr = asOfDate((approved[u.repository] || {})[c.k], asOf)
    return appr ? { s:'dev', spec, v, audit:appr } : { s:'bad', spec, v }
  })
}

// Not-scanned stays in the denominator: silence is not conformance.
export const totalOf = (cs) => {
  const app = cs.filter((c) => c.s !== 'na')
  return { met: app.filter((c) => c.s === 'ok' || c.s === 'dev').length, of: app.length }
}
