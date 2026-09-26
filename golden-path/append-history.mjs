#!/usr/bin/env node
/* Appends this run to history.json from the files the pipeline just wrote, rather than replaying
   git log. Run it (npm run history:append) after npm run regenerate and before committing, so a
   bad run fails the guard instead of being baked in. Nothing schedules it: the history only grows
   when someone refreshes the data.

     node golden-path/append-history.mjs */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rowsFrom } from './lib/snapshot.mjs'
import { rowsAfter, diffRows } from './lib/history.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const OUT = path.join(HERE, 'history.json')
const DAY_MS = 86400_000
const RUNTIME_FACTS_MAX_AGE_MS = 14 * DAY_MS

// No fallback: a missing or unparsable input must fail the run, or the night is committed with
// every repository's scanned facts silently gone (append-only — the hole would be permanent).
const readRepoJson = (file) => JSON.parse(readFileSync(path.join(REPO, file), 'utf8'))

function readOptionalRepoJson(file) {
  try {
    return readRepoJson(file)
  } catch (error) {
    // Corruption must fail the night, not silently drop the columns.
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

// The runtime proof (what your observability platform actually received) is optional — absent
// until you write one — and must not go stale silently: too old means whatever produces it is
// broken, so its facts are dropped rather than trusted. Fail closed: a missing or unparsable
// generatedAt (NaN) must read as stale, not as fresh forever.
function loadRuntimeFacts() {
  const runtime = readOptionalRepoJson('runtime-facts.json')
  if (!runtime) return null
  const isFresh = Date.now() - Date.parse(runtime.generatedAt) <= RUNTIME_FACTS_MAX_AGE_MS
  if (!isFresh) {
    console.warn(`runtime-facts.json is stale (${runtime.generatedAt}) — ignoring it`)
    return null
  }
  const listsAreArrays =
    Array.isArray(runtime.checked) && Array.isArray(runtime.logs) && Array.isArray(runtime.traces)
  if (!listsAreArrays) {
    throw new Error('runtime-facts.json is malformed (checked/logs/traces must be arrays)')
  }
  return runtime
}

const runtime = loadRuntimeFacts()
const meta = readRepoJson('github-meta.json')
const rows = rowsFrom({
  meta,
  fe: readRepoJson('fe-architecture.json'),
  be: readRepoJson('backend-tooling.json'),
  runtime,
})
if (!rows) throw new Error('github-meta.json missing repos — nothing to append')

const out = JSON.parse(readFileSync(OUT, 'utf8'))
const today = new Date().toISOString().slice(0, 10)

// Idempotent: a retried run diffs against the night before, not against itself.
const previousRows = rowsAfter(out.history.filter((night) => night.date !== today))
const changed = diffRows(previousRows, rows)

const entry = { date: today, changed }
const todayIndex = out.history.findIndex((night) => night.date === today)
if (todayIndex === -1) out.history.push(entry)
else out.history[todayIndex] = entry

out.generatedAt = new Date().toISOString()
// The screen's GitHub links resolve against the real org, not a hardcoded one.
if (meta.org) out.org = meta.org
writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(
  `${today}: ${Object.keys(changed).length} repositories changed, ${Object.keys(rows).length} total, ${out.history.length} nights`,
)
