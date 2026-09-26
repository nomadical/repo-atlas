// Tests for backend-scan's pure framework-dependency extraction (the scan itself needs cloned
// repos, so only the parsing is unit-tested). Run with `node --test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractFrameworkDeps } from './backend-scan.mjs'

const CONF = {
  _comment: 'ignored',
  'platform-core': { group: 'com.meridian.platform', versionProp: 'platformVersion' },
}

test('gradle coordinates with a ${prop} version resolve via the version property', () => {
  const build = [
    'implementation "com.meridian.platform:platform-messaging:${platformVersion}"\nimplementation "com.meridian.platform:platform-quarkus:${platformVersion}"',
  ]
  const frameworks = extractFrameworkDeps(build, 'platformVersion=1.0.0\n', CONF)
  assert.deepEqual(frameworks['platform-core'], {
    version: '1.0.0',
    artifacts: ['platform-messaging', 'platform-quarkus'],
  })
})

test('a literal version in the coordinate wins when no property is set', () => {
  const frameworks = extractFrameworkDeps(
    ["implementation 'com.meridian.platform:platform-core:2.3.4'"],
    '',
    CONF,
  )
  assert.deepEqual(frameworks['platform-core'], { version: '2.3.4', artifacts: ['platform-core'] })
})

test('maven groupId/artifactId blocks parse, with and without a version element', () => {
  const pom = [
    '<dependency><groupId>com.meridian.platform</groupId>\n<artifactId>platform-core</artifactId>\n<version>2.1.0</version></dependency><dependency><groupId>com.meridian.platform</groupId><artifactId>platform-events</artifactId></dependency>',
  ]
  const frameworks = extractFrameworkDeps(pom, '', { 'platform-core': 'com.meridian.platform' })
  assert.deepEqual(frameworks['platform-core'], {
    version: '2.1.0',
    artifacts: ['platform-core', 'platform-events'],
  })
})

test('a repo not using the framework produces no entry; unrelated groups are ignored', () => {
  const frameworks = extractFrameworkDeps(
    ['implementation "io.quarkus:quarkus-core:3.20.4"'],
    'platformVersion=1.0.0',
    CONF,
  )
  assert.deepEqual(frameworks, {})
})

test('unresolvable version degrades to null, artifacts still reported', () => {
  const frameworks = extractFrameworkDeps(
    ['implementation "com.meridian.platform:platform-core:${someOtherProp}"'],
    '',
    CONF,
  )
  assert.deepEqual(frameworks['platform-core'], { version: null, artifacts: ['platform-core'] })
})
