// Backfill the inventory Documentation from an export of the (deprecated) Confluence "Component
// Inventory" database — either its CSV export or its rendered HTML export.
//
// A component's documentation is two fields: `doc` is the human label shown in the UI, `docUrl` is
// the actual link (a bare `doc` with no `docUrl` routes to a wiki search). The live source of truth
// is now GitHub metadata + inventory-extra.json; this only rescues the Documentation column the
// legacy database still holds. It is careful with existing data:
//   • fills `doc` (label) where a component has none, and
//   • fills/updates `docUrl` from the export — the HTML export preserves each Documentation cell's
//     real hyperlink, so bare-title docs gain a direct link instead of a search.
// Rows are matched to components by no-repo name first (most specific), then GitHub repo URL, then
// canonical name/alias (the legacy export carries some pre-rename repo URLs). Safe to re-run.
//
// Usage:  node scripts/backfill-docs.mjs <export.csv|export.html>   (default: ./component-inventory.csv)
//         node scripts/backfill-docs.mjs <export> --dry             (report only, write nothing)
import fs from 'node:fs'
import path from 'node:path'

import { AUDIT } from './_paths.mjs'
import { parseCsv } from './inventory.mjs'

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const srcArg = args.find((a) => !a.startsWith('--'))
const SRC = srcArg ? path.resolve(srcArg) : path.join(AUDIT, 'component-inventory.csv')
const EXTRA = path.join(AUDIT, 'inventory-extra.json')
const GH_META = path.join(AUDIT, 'github-meta.json')

let raw
try {
  raw = fs.readFileSync(SRC, 'utf8')
} catch {
  console.error(
    `backfill-docs: source not found at ${SRC}\n` +
      `  Export the Confluence database (••• → Export → CSV, or save the page as HTML), then:\n` +
      `  node scripts/backfill-docs.mjs <that-file>`,
  )
  process.exit(1)
}

const repoBasename = (cell) => {
  // repo segment allows dots (md.kb is a legal repo name); the anchored optional .git still strips
  const m = String(cell || '').match(/github\.com\/[^/\s]+\/([^/\s]+?)(?:\.git)?\/?$/i)
  return m ? m[1] : null
}
const isUrl = (s) => /^https?:\/\//i.test(String(s || ''))

// --- normalize either export into rows of {name, doc, repoName}. For HTML the doc is the cell's
// real hyperlink when present (so bare titles become direct URLs), else the cell text. ---
function rowsFromCsv(text) {
  const [header, ...rowArrays] = parseCsv(text)
  if (!header) return []
  const find = (...needles) => header.find((h) => needles.some((n) => h.toLowerCase().includes(n)))
  const docCol = find('document')
  const repoCol = find('github', 'repo')
  const nameCol = find('component', 'name') || header[0]
  if (!docCol) {
    console.error(`backfill-docs: no Documentation column found. Headers: ${header.join(' | ')}`)
    process.exit(1)
  }
  console.log(`CSV columns → name: "${nameCol}"  repo: "${repoCol || '(none)'}"  doc: "${docCol}"`)
  // The CSV has no separate hyperlink column: a doc cell is a label, unless it is itself a URL.
  return rowArrays.map((r) => {
    const o = Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()]))
    const v = o[docCol]
    return { name: o[nameCol], label: isUrl(v) ? '' : v, url: isUrl(v) ? v : '', repoName: repoCol ? repoBasename(o[repoCol]) : null }
  })
}

const stripTags = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#xa0;|&nbsp;/gi, ' ')
    .trim()

function rowsFromHtml(html) {
  const body = html.split(/<tbody>/i)[1] || html
  const trs = [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1])
  // Header order matches the CSV: Name … Documentation(11) GitHub Repo(12). Detect doc/name/repo
  // indices from the <th> row so a reordered export still works.
  const ths = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => stripTags(m[1]).toLowerCase())
  const idx = (...needles) => ths.findIndex((h) => needles.some((n) => h.includes(n)))
  const docI = idx('document') >= 0 ? idx('document') : 11
  const nameI = idx('component', 'name') >= 0 ? idx('component', 'name') : 0
  const repoI = idx('github', 'repo') >= 0 ? idx('github', 'repo') : 12
  console.log(`HTML columns → name#${nameI}  repo#${repoI}  doc#${docI} (of ${ths.length} headers)`)
  const out = []
  for (const tr of trs) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1])
    if (cells.length <= docI) continue
    const name = stripTags(cells[nameI] || '')
    const docCell = cells[docI] || ''
    const href = (docCell.match(/href="([^"]+)"/) || [])[1] || ''
    const label = stripTags(docCell)
    const repoName = repoI < cells.length ? repoBasename((cells[repoI].match(/href="([^"]+)"/) || [])[1] || cells[repoI]) : null
    out.push({ name, label: isUrl(label) ? '' : label, url: href || (isUrl(label) ? label : ''), repoName })
  }
  return out
}

const isHtml = /\.html?$/i.test(SRC) || /^\s*<!doctype html|<html/i.test(raw.slice(0, 200))
const rows = isHtml ? rowsFromHtml(raw) : rowsFromCsv(raw)

let knownRepos = null
try {
  knownRepos = new Set(Object.keys(JSON.parse(fs.readFileSync(GH_META, 'utf8'))?.repos || {}))
} catch {}

const extra = JSON.parse(fs.readFileSync(EXTRA, 'utf8'))
extra.repoExtras = extra.repoExtras || {}
extra.nonRepo = extra.nonRepo || []
const nonRepoByName = new Map(extra.nonRepo.map((e) => [String(e.name).toLowerCase(), e]))

// The legacy export's repo column can hold stale/pre-rename URLs that no longer match the canonical
// repo the pipeline tracks. Map the component NAME to its canonical repoExtras key for the handful
// of renames/ACR aliases where a name-equality match isn't enough.
const NAME_TO_KEY = { 'control-intervention-backend': 'intervention-backend' }

const resolveTarget = (name, repoName) => {
  // A no-repo record keyed by the exact component name is the most specific match — prefer it over a
  // repo record, since several components can share one repo (e.g. the device-data-* family) and the
  // per-repo `doc` can hold only one of their pages.
  if (nonRepoByName.has(name.toLowerCase())) return ['nonRepo', nonRepoByName.get(name.toLowerCase())]
  if (repoName && (extra.repoExtras[repoName] || !knownRepos || knownRepos.has(repoName))) return ['repo', repoName]
  const keyByName = NAME_TO_KEY[name] || (extra.repoExtras[name] ? name : null)
  if (keyByName) return ['repo', keyByName]
  return [null, null]
}

const linked = [] // gained/changed a docUrl
const labelled = [] // gained a doc label
const kept = []
const unmatched = []

const apply = (rec, tag, label, url) => {
  const notes = []
  if (label && !rec.doc) {
    rec.doc = label
    labelled.push(`${tag} → label "${label}"`)
    notes.push('label')
  }
  if (url && rec.docUrl !== url) {
    linked.push(`${tag} ("${rec.doc || label}") → ${url}`)
    rec.docUrl = url
    notes.push('url')
  }
  if (!notes.length) kept.push(`${tag} → unchanged ("${rec.doc || ''}")`)
}

for (const { name, label, url, repoName } of rows) {
  if ((!label && !url) || !name) continue
  const [kind, ref] = resolveTarget(name, repoName)
  if (kind === 'repo') apply((extra.repoExtras[ref] = extra.repoExtras[ref] || {}), `${name} (${ref})`, label, url)
  else if (kind === 'nonRepo') apply(ref, `${name} (no-repo)`, label, url)
  else unmatched.push(`${name}${repoName ? ` (repo ${repoName} not tracked)` : ' (no repo, no matching component)'} → "${label || url}"`)
}

const p = (heading, list) => {
  console.log(`\n${heading} (${list.length})`)
  for (const l of list) console.log('  ' + l)
}
p('Linked (docUrl set/changed)', linked)
p('Labelled (doc filled)', labelled)
p('Unchanged', kept)
p('Unmatched (skipped — component not in inventory)', unmatched)

const changed = linked.length + labelled.length
if (dry) {
  console.log('\n--dry: no file written.')
} else if (changed) {
  fs.writeFileSync(EXTRA, JSON.stringify(extra, null, 2) + '\n')
  console.log(`\nWrote ${linked.length} link(s) + ${labelled.length} label(s) to inventory-extra.json.`)
  console.log('Run "npm run regenerate" (or the nightly) to publish, then commit inventory-extra.json.')
} else {
  console.log('\nNothing to change — every matched component already has an up-to-date doc.')
}
