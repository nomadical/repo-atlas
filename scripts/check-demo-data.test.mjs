// The demo-data lock: real estate data must not replace the committed demo. Run with `node --test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DATA_FILES, findRealData } from './check-demo-data.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const committed = () =>
  Object.fromEntries(
    DATA_FILES.map((file) => [file, JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))]),
  )
const DEMO_ORG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).demoDataOrg

test('the committed data passes the lock it ships with', () => {
  assert.ok(DEMO_ORG, 'config.json should name the demo org')
  assert.deepEqual(findRealData(committed(), DEMO_ORG), [])
})

test('a regenerated architecture for another org is caught', () => {
  const contents = committed()
  contents['fe-architecture.json'] = { ...contents['fe-architecture.json'], org: '' }
  contents['github-meta.json'] = { ...contents['github-meta.json'], org: 'acme-corp' }
  const problems = findRealData(contents, DEMO_ORG)
  assert.equal(problems.length, 2)
  assert.match(problems[0], /fe-architecture\.json describes org ""/)
  assert.match(problems[1], /github-meta\.json describes org "acme-corp"/)
})

test('real repos in the files without an org field are caught', () => {
  const contents = committed()
  contents['backend-tooling.json'] = { scanned: { 'intervention-backend': {} }, missing: [] }
  contents['name-drift.json'] = { renames: [{ from: 'old-portal', to: 'new-portal' }], missing: [] }
  const problems = findRealData(contents, DEMO_ORG)
  assert.equal(problems.length, 2)
  assert.match(problems[0], /backend-tooling\.json .*intervention-backend/)
  assert.match(problems[1], /name-drift\.json .*old-portal, new-portal/)
})

test('without demoDataOrg the lock is off, so forks can commit their own data', () => {
  const contents = committed()
  contents['github-meta.json'] = { ...contents['github-meta.json'], org: 'acme-corp' }
  assert.deepEqual(findRealData(contents, undefined), [])
})
