#!/usr/bin/env node
/* One-shot backfill: replays the nightly commits in git into the daily series. The nightly path is
   append-history.mjs, not this.

     node golden-path/build-history.mjs           # full history
     node golden-path/build-history.mjs --days 2  # last 2 nights, for a smoke test

   Carries facts, never verdicts — the page applies the rules at read time, so the table and the
   chart cannot disagree. Each entry lists only what changed that night; the file describes its own
   shape in `format` and `fields`. */
import { execFileSync } from 'node:child_process'
import { writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rowsFrom } from './lib/snapshot.mjs'
import { diffRows } from './lib/history.mjs'

// Paths are anchored to this file, so the script runs the same from any working directory.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const OUT = path.join(HERE, 'history.json')
const SRC = ['github-meta.json', 'fe-architecture.json', 'backend-tooling.json']
// stderr ignored: `git show` shouts when a file did not exist yet that night, which is expected.
const git = (...a) => execFileSync('git', a, { cwd:REPO, encoding:'utf8', maxBuffer:1 << 28, stdio:['ignore', 'pipe', 'ignore'] })

// One commit per date: the last one, so a day carries the state it went to bed with.
const commits = git('log', '--format=%H %ad', '--date=short', '--', ...SRC).trim().split('\n')
const byDay = new Map()
for (const line of commits) {                       // git logs newest first
  const [sha, day] = line.split(' ')
  if (!byDay.has(day)) byDay.set(day, sha)
}
let days = [...byDay.keys()].sort()

// --days N: keep only the last N calendar nights, for quick smoke-testing this ~7s-per-night replay.
const daysArg = process.argv.indexOf('--days')
if (daysArg !== -1) days = days.slice(-Number(process.argv[daysArg + 1]))

const read = (sha, file) => {
  try { return JSON.parse(git('show', `${sha}:${file}`)) } catch { return null }
}

function snapshot(sha) {
  return rowsFrom({
    meta: read(sha, 'github-meta.json'),
    fe: read(sha, 'fe-architecture.json'),
    be: read(sha, 'backend-tooling.json'),
  })
}

const snaps = []
for (const d of days) {
  const rows = snapshot(byDay.get(d))
  if (rows) snaps.push({ d, rows })
  process.stderr.write(`\r${snaps.length}/${days.length} nights`)
}
process.stderr.write('\n')
if (!snaps.length) throw new Error('no nightly snapshots found in git history')

// The first night lists everything; after that, only what moved.
const history = snaps.map(({ d, rows }, i) =>
  ({ date:d, changed: i ? diffRows(snaps[i - 1].rows, rows) : rows }))

const out = {
  generatedAt: new Date().toISOString(),
  source: `replayed from git log over ${SRC.join(', ')} — one entry per night the pipeline ran`,
  format: 'history[].changed maps a repository name to its state that night, or to null if it was '
    + 'gone. Apply the entries in order to rebuild any night; the first one carries every repository.',
  fields: {
    repository: 'GitHub repository name, and the key of the row',
    type: 'from the type-* topic on the repository; Unclassified when there is none',
    owner: 'team, from the Component Inventory or the owner-* topic',
    applications: 'products the component serves',
    status: 'lifecycle status from the inventory: Current, Planned, Sunsetting',
    archived: 'present and true when the repository is archived on GitHub',
    contact: 'technical contact from the inventory',
    inventoryName: 'inventory display name, present only when it differs from the repository name',
    archMapIgnore: 'present and true when the repository carries the arch-map-ignore topic. That '
      + 'topic keeps a repository off the architecture map; it says nothing about the Golden Path, '
      + 'so this page does not read it. Carried as a fact, deliberately unused.',
    language: 'scanned language and version — Java for backends, TypeScript/JavaScript for front ends',
    framework: 'scanned framework and version — Quarkus or React',
    buildTool: 'scanned build tool — Maven or Gradle; null where nothing was scanned',
  },
  history,
}
writeFileSync(OUT, JSON.stringify(out, null, 2))
const last = snaps[snaps.length - 1].rows
console.log(`${snaps.length} nights, ${snaps[0].d} → ${snaps[snaps.length - 1].d}`)
console.log(`${Object.keys(last).length} repositories on the last night, ` +
  `${Object.values(last).filter((r) => r.type === 'Unclassified').length} unclassified, ` +
  `${Object.values(last).filter((r) => r.archived).length} archived, ` +
  `${Object.values(last).filter((r) => r.archMapIgnore).length} tagged arch-map-ignore`)
console.log(`history.json — ${(statSync(OUT).size / 1024).toFixed(0)} KB, ` +
  `${history.filter((n) => !Object.keys(n.changed).length).length} nights with nothing changed`)
