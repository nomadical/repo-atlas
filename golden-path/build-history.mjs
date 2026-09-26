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
const SOURCES = ['github-meta.json', 'fe-architecture.json', 'backend-tooling.json']
const GIT_MAX_BUFFER = 1 << 28

// stderr ignored: `git show` shouts when a file did not exist yet that night, which is expected.
const git = (...args) =>
  execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore'],
  })

// One commit per date: the last one, so a day carries the state it went to bed with.
function lastCommitPerDay() {
  const lines = git('log', '--format=%H %ad', '--date=short', '--', ...SOURCES)
    .trim()
    .split('\n')
  const shaByDay = new Map()
  // git logs newest first, so the first commit seen for a day is its last.
  for (const line of lines) {
    const [sha, day] = line.split(' ')
    if (!shaByDay.has(day)) shaByDay.set(day, sha)
  }
  return shaByDay
}

// --days N: keep only the last N calendar nights, for quick smoke-testing this ~7s-per-night replay.
// Anything but a positive whole number is refused: `slice(-0)` would quietly replay every night.
function daysToKeep() {
  const daysFlag = process.argv.indexOf('--days')
  if (daysFlag === -1) return null
  const value = process.argv[daysFlag + 1]
  const days = Number(value)
  if (!Number.isInteger(days) || days < 1) {
    console.error(`--days must be a positive whole number, got ${value ?? 'nothing'}`)
    process.exit(1)
  }
  return days
}

function selectDays(allDays, keep) {
  return keep ? allDays.slice(-keep) : allDays
}

const readAtCommit = (sha, file) => {
  try {
    return JSON.parse(git('show', `${sha}:${file}`))
  } catch {
    return null
  }
}

function snapshot(sha) {
  return rowsFrom({
    meta: readAtCommit(sha, 'github-meta.json'),
    fe: readAtCommit(sha, 'fe-architecture.json'),
    be: readAtCommit(sha, 'backend-tooling.json'),
  })
}

function replayNights(shaByDay, days) {
  const snapshots = []
  for (const day of days) {
    const rows = snapshot(shaByDay.get(day))
    if (rows) snapshots.push({ d: day, rows })
    process.stderr.write(`\r${snapshots.length}/${days.length} nights`)
  }
  process.stderr.write('\n')
  return snapshots
}

const FIELDS = {
  repository: 'GitHub repository name, and the key of the row',
  type: 'from the type-* topic on the repository; Unclassified when there is none',
  owner: 'team, from the Component Inventory or the owner-* topic',
  applications: 'products the component serves',
  status: 'lifecycle status from the inventory: Current, Planned, Sunsetting',
  archived: 'present and true when the repository is archived on GitHub',
  contact: 'technical contact from the inventory',
  inventoryName: 'inventory display name, present only when it differs from the repository name',
  archMapIgnore:
    'present and true when the repository carries the arch-map-ignore topic. That ' +
    'topic keeps a repository off the architecture map; it says nothing about the Golden Path, ' +
    'so this page does not read it. Carried as a fact, deliberately unused.',
  language: 'scanned language and version — Java for backends, TypeScript/JavaScript for front ends',
  framework: 'scanned framework and version — Quarkus or React',
  buildTool: 'scanned build tool — Maven or Gradle; null where nothing was scanned',
}

function printSummary(snapshots, history) {
  const first = snapshots[0]
  const last = snapshots[snapshots.length - 1]
  const lastRows = Object.values(last.rows)
  const countLast = (predicate) => lastRows.filter(predicate).length
  const unchangedNights = history.filter((night) => !Object.keys(night.changed).length).length
  console.log(`${snapshots.length} nights, ${first.d} → ${last.d}`)
  console.log(
    `${lastRows.length} repositories on the last night, ` +
      `${countLast((row) => row.type === 'Unclassified')} unclassified, ` +
      `${countLast((row) => row.archived)} archived, ` +
      `${countLast((row) => row.archMapIgnore)} tagged arch-map-ignore`,
  )
  console.log(
    `history.json — ${(statSync(OUT).size / 1024).toFixed(0)} KB, ` +
      `${unchangedNights} nights with nothing changed`,
  )
}

const keep = daysToKeep()
const shaByDay = lastCommitPerDay()
const days = selectDays([...shaByDay.keys()].sort(), keep)
const snapshots = replayNights(shaByDay, days)
if (!snapshots.length) throw new Error('no nightly snapshots found in git history')

// The first night lists everything; after that, only what moved.
const history = snapshots.map(({ d, rows }, index) => ({
  date: d,
  changed: index ? diffRows(snapshots[index - 1].rows, rows) : rows,
}))

const out = {
  generatedAt: new Date().toISOString(),
  source: `replayed from git log over ${SOURCES.join(', ')} — one entry per night the pipeline ran`,
  format:
    'history[].changed maps a repository name to its state that night, or to null if it was ' +
    'gone. Apply the entries in order to rebuild any night; the first one carries every repository.',
  fields: FIELDS,
  history,
}
writeFileSync(OUT, JSON.stringify(out, null, 2))
printSummary(snapshots, history)
