// Backfills inventory documentation from an export (CSV or rendered HTML) of the deprecated
// Confluence "Component Inventory" database.
//
// A component's documentation is `doc`, the label shown in the UI, and `docUrl`, the link (a bare
// `doc` routes to a wiki search). This only fills `doc` where it is empty, and sets `docUrl` from
// the export: the HTML export keeps each cell's real hyperlink, so bare titles gain a direct link.
// Rows match a no-repo component by name first, then a GitHub repo URL, then a canonical name.
// Safe to re-run.
//
// Usage:  node scripts/backfill-docs.mjs <export.csv|export.html>   (default: ./component-inventory.csv)
//         node scripts/backfill-docs.mjs <export> --dry             (report only, write nothing)
import fs from 'node:fs'
import path from 'node:path'

import { AUDIT } from './_paths.mjs'
import { parseCsv } from './inventory.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry')
const sourceArg = args.find((arg) => !arg.startsWith('--'))
const SOURCE = sourceArg ? path.resolve(sourceArg) : path.join(AUDIT, 'component-inventory.csv')
const EXTRA = path.join(AUDIT, 'inventory-extra.json')
const GH_META = path.join(AUDIT, 'github-meta.json')

// Column positions in the legacy HTML export when its header row can't be read.
const DEFAULT_HTML_COLUMNS = { name: 0, doc: 11, repo: 12 }
const SNIFF_CHARS = 200

// The legacy export's repo column can hold pre-rename URLs, so these component names map to
// their canonical repoExtras key where a name match isn't enough.
const REPO_KEY_BY_NAME = new Map([['control-intervention-backend', 'intervention-backend']])

function readSource() {
  try {
    return fs.readFileSync(SOURCE, 'utf8')
  } catch {
    console.error(
      `backfill-docs: source not found at ${SOURCE}\n` +
        `  Export the Confluence database (••• → Export → CSV, or save the page as HTML), then:\n` +
        `  node scripts/backfill-docs.mjs <that-file>`,
    )
    process.exit(1)
  }
}

// Dots are allowed in the repo segment (md.kb is a legal name); a trailing .git is still stripped.
const repoBasename = (cell) =>
  String(cell || '').match(/github\.com\/[^/\s]+\/([^/\s]+?)(?:\.git)?\/?$/i)?.[1] || null

const isUrl = (text) => /^https?:\/\//i.test(String(text || ''))

const firstHref = (html) => html.match(/href="([^"]+)"/)?.[1]

// ---- Normalize either export into rows of { name, label, url, repoName } -----------------------

function rowsFromCsv(text) {
  const [header, ...rowArrays] = parseCsv(text)
  if (!header) return []
  const findColumn = (...needles) =>
    header.find((column) => needles.some((needle) => column.toLowerCase().includes(needle)))
  const docColumn = findColumn('document')
  const repoColumn = findColumn('github', 'repo')
  const nameColumn = findColumn('component', 'name') || header[0]
  if (!docColumn) {
    console.error(`backfill-docs: no Documentation column found. Headers: ${header.join(' | ')}`)
    process.exit(1)
  }
  console.log(`CSV columns → name: "${nameColumn}"  repo: "${repoColumn || '(none)'}"  doc: "${docColumn}"`)
  // The CSV has no hyperlink column: a doc cell is a label unless it is itself a URL.
  return rowArrays.map((cells) => {
    const record = Object.fromEntries(header.map((column, index) => [column, (cells[index] || '').trim()]))
    const doc = record[docColumn]
    return {
      name: record[nameColumn],
      label: isUrl(doc) ? '' : doc,
      url: isUrl(doc) ? doc : '',
      repoName: repoColumn ? repoBasename(record[repoColumn]) : null,
    }
  })
}

const stripTags = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#xa0;|&nbsp;/gi, ' ')
    .trim()

const innerHtmlOf = (regex, html) => [...html.matchAll(regex)].map((match) => match[1])

// Column indices come from the <th> row so a reordered export still works.
function htmlColumns(html) {
  const headers = innerHtmlOf(/<th[^>]*>([\s\S]*?)<\/th>/g, html).map((th) => stripTags(th).toLowerCase())
  const columnIndex = (needles, fallback) => {
    const index = headers.findIndex((header) => needles.some((needle) => header.includes(needle)))
    return index >= 0 ? index : fallback
  }
  return {
    doc: columnIndex(['document'], DEFAULT_HTML_COLUMNS.doc),
    name: columnIndex(['component', 'name'], DEFAULT_HTML_COLUMNS.name),
    repo: columnIndex(['github', 'repo'], DEFAULT_HTML_COLUMNS.repo),
    headerCount: headers.length,
  }
}

// The doc URL is the cell's real hyperlink when present, else the cell text if that is a URL.
function rowsFromHtml(html) {
  const body = html.split(/<tbody>/i)[1] || html
  const columns = htmlColumns(html)
  console.log(
    `HTML columns → name#${columns.name}  repo#${columns.repo}  doc#${columns.doc} (of ${columns.headerCount} headers)`,
  )
  const rows = []
  for (const tableRow of innerHtmlOf(/<tr>([\s\S]*?)<\/tr>/g, body)) {
    const cells = innerHtmlOf(/<td[^>]*>([\s\S]*?)<\/td>/g, tableRow)
    if (cells.length <= columns.doc) continue
    const docCell = cells[columns.doc] || ''
    const label = stripTags(docCell)
    const repoCell = cells[columns.repo]
    rows.push({
      name: stripTags(cells[columns.name] || ''),
      label: isUrl(label) ? '' : label,
      url: firstHref(docCell) || (isUrl(label) ? label : ''),
      repoName: columns.repo < cells.length ? repoBasename(firstHref(repoCell) || repoCell) : null,
    })
  }
  return rows
}

function readKnownRepos() {
  try {
    return new Set(Object.keys(JSON.parse(fs.readFileSync(GH_META, 'utf8'))?.repos || {}))
  } catch {
    return null
  }
}

// ---- Matching and applying -------------------------------------------------------------------

const raw = readSource()
const isHtml = /\.html?$/i.test(SOURCE) || /^\s*<!doctype html|<html/i.test(raw.slice(0, SNIFF_CHARS))
const rows = isHtml ? rowsFromHtml(raw) : rowsFromCsv(raw)
const knownRepos = readKnownRepos()

const extra = JSON.parse(fs.readFileSync(EXTRA, 'utf8'))
extra.repoExtras = extra.repoExtras || {}
extra.nonRepo = extra.nonRepo || []
const nonRepoByName = new Map(extra.nonRepo.map((record) => [String(record.name).toLowerCase(), record]))

// Returns [kind, target]: ['nonRepo', record], ['repo', repoExtras key] or [null, null].
function resolveTarget(name, repoName) {
  // Several components can share one repo (the device-data-* family) and a repo's `doc` holds only
  // one page, so a no-repo record with the exact name is the most specific match.
  const nonRepo = nonRepoByName.get(name.toLowerCase())
  if (nonRepo) return ['nonRepo', nonRepo]
  const isTrackedRepo = extra.repoExtras[repoName] || !knownRepos || knownRepos.has(repoName)
  if (repoName && isTrackedRepo) return ['repo', repoName]
  const keyByName = REPO_KEY_BY_NAME.get(name) || (extra.repoExtras[name] ? name : null)
  if (keyByName) return ['repo', keyByName]
  return [null, null]
}

const linked = [] // gained or changed a docUrl
const labelled = [] // gained a doc label
const unchanged = []
const unmatched = []

function applyDoc(record, tag, label, url) {
  let changed = false
  if (label && !record.doc) {
    record.doc = label
    labelled.push(`${tag} → label "${label}"`)
    changed = true
  }
  if (url && record.docUrl !== url) {
    linked.push(`${tag} ("${record.doc || label}") → ${url}`)
    record.docUrl = url
    changed = true
  }
  if (!changed) unchanged.push(`${tag} → unchanged ("${record.doc || ''}")`)
}

function repoExtraFor(key) {
  if (!extra.repoExtras[key]) extra.repoExtras[key] = {}
  return extra.repoExtras[key]
}

for (const { name, label, url, repoName } of rows) {
  if ((!label && !url) || !name) continue
  const [kind, target] = resolveTarget(name, repoName)
  if (kind === 'repo') {
    applyDoc(repoExtraFor(target), `${name} (${target})`, label, url)
  } else if (kind === 'nonRepo') {
    applyDoc(target, `${name} (no-repo)`, label, url)
  } else {
    const reason = repoName ? ` (repo ${repoName} not tracked)` : ' (no repo, no matching component)'
    unmatched.push(`${name}${reason} → "${label || url}"`)
  }
}

// ---- Report ----------------------------------------------------------------------------------

function printList(heading, items) {
  console.log(`\n${heading} (${items.length})`)
  for (const item of items) console.log('  ' + item)
}

printList('Linked (docUrl set/changed)', linked)
printList('Labelled (doc filled)', labelled)
printList('Unchanged', unchanged)
printList('Unmatched (skipped — component not in inventory)', unmatched)

const changedCount = linked.length + labelled.length
if (dryRun) {
  console.log('\n--dry: no file written.')
} else if (changedCount) {
  fs.writeFileSync(EXTRA, JSON.stringify(extra, null, 2) + '\n')
  console.log(`\nWrote ${linked.length} link(s) + ${labelled.length} label(s) to inventory-extra.json.`)
  console.log('Run "npm run regenerate" (or the nightly) to publish, then commit inventory-extra.json.')
} else {
  console.log('\nNothing to change — every matched component already has an up-to-date doc.')
}
