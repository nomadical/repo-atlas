import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../build-history.mjs', import.meta.url))

// Only invalid values are run here: a valid one would replay git and rewrite history.json.
for (const value of ['0', '-2', 'abc', '1.5']) {
  test(`build-history refuses --days ${value} before replaying anything`, () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--days', value], { encoding: 'utf8' })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /--days must be a positive whole number/)
  })
}
