#!/usr/bin/env node
/* Appends tonight to history.json from the files the pipeline just wrote, rather than replaying
   git log. Runs before the commit step, so a bad night fails the guard instead of being baked in.

     node golden-path/append-history.mjs */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rowsFrom } from './lib/snapshot.mjs'
import { rowsAfter, diffRows } from './lib/history.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const OUT = path.join(HERE, 'history.json')

// No fallback: a missing or unparsable input must fail the run, or the night is committed with
// every repository's scanned facts silently gone (append-only — the hole would be permanent).
const read = (file) => JSON.parse(readFileSync(path.join(REPO, file), 'utf8'))

// The runtime proof (what your observability platform actually received) is optional — absent
// until you write one — and must not go stale silently: older than 14 days means whatever produces
// it is broken, so its facts are dropped rather than trusted. Fail closed: a missing or unparsable
// generatedAt (NaN) must read as stale, not as fresh forever.
let runtime = null
try { runtime = JSON.parse(readFileSync(path.join(REPO, 'runtime-facts.json'), 'utf8')) } catch (e) {
  if (e.code !== 'ENOENT') throw e // corruption must fail the night, not silently drop the columns
}
if (runtime && !(Date.now() - Date.parse(runtime.generatedAt) <= 14 * 86400_000)) {
  console.warn(`runtime-facts.json is stale (${runtime.generatedAt}) — ignoring it`)
  runtime = null
}
if (runtime && !(Array.isArray(runtime.checked) && Array.isArray(runtime.logs) && Array.isArray(runtime.traces))) {
  throw new Error('runtime-facts.json is malformed (checked/logs/traces must be arrays)')
}

const meta = read('github-meta.json')
const rows = rowsFrom({
  meta,
  fe: read('fe-architecture.json'),
  be: read('backend-tooling.json'),
  runtime,
})
if (!rows) throw new Error('github-meta.json missing repos — nothing to append')

const out = JSON.parse(readFileSync(OUT, 'utf8'))
const today = new Date().toISOString().slice(0, 10)

// Idempotent: a retried run diffs against the night before, not against itself.
const prevRows = rowsAfter(out.history.filter((h) => h.date !== today))
const changed = diffRows(prevRows, rows)

const entry = { date: today, changed }
const idx = out.history.findIndex((h) => h.date === today)
if (idx === -1) out.history.push(entry)
else out.history[idx] = entry

out.generatedAt = new Date().toISOString()
if (meta.org) out.org = meta.org // the screen's GitHub links resolve against the real org, not a hardcoded one
writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`${today}: ${Object.keys(changed).length} repositories changed, ${Object.keys(rows).length} total, ${out.history.length} nights`)
