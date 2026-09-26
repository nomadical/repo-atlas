// Per-repo extras for the frontends: purpose, CODEOWNERS and test counts. Writes
// scripts/extras-mid.json for extras-assemble.mjs.
import fs from 'node:fs'
import path from 'node:path'

import { ROOT, AUDIT } from './_paths.mjs'
import { repos } from './repos.mjs'

const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'storybook-static',
  'coverage',
  '.yalc',
])
const CODEOWNERS_CANDIDATES = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']
const COVERAGE_CANDIDATES = [
  'coverage/coverage-summary.json',
  'coverage-summary.json',
  'coverage/coverage-final.json',
]
const PLAYWRIGHT_CONFIGS = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs']
const MAX_PURPOSE_LENGTH = 200
const HEADING = /^#{1,6}\s+/
const REPO_COLUMN_WIDTH = 26
const COUNT_COLUMN_WIDTH = 4

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const firstExisting = (repoDir, candidates) =>
  candidates.map((candidate) => path.join(repoDir, candidate)).find((file) => fs.existsSync(file))

function listFiles(dir, files = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (!entry.isDirectory()) files.push(entryPath)
    else if (!SKIPPED_DIRS.has(entry.name)) listFiles(entryPath, files)
  }
  return files
}

// The first prose line of the README, else its first heading.
function readmeSummary(readmePath) {
  let heading = null
  for (const line of fs.readFileSync(readmePath, 'utf8').split('\n')) {
    const text = line.trim()
    if (!text) continue
    if (!heading && HEADING.test(text)) {
      heading = text.replace(HEADING, '').trim()
      continue
    }
    const isProse = !/^[#>!\-*`|]/.test(text) && !/^<!--/.test(text)
    if (isProse) return text.replace(/\s+/g, ' ').slice(0, MAX_PURPOSE_LENGTH)
  }
  return heading
}

function purpose(repoDir, packageJson) {
  if (packageJson?.description) return { source: 'package.json', text: packageJson.description }
  const readmePath = path.join(repoDir, 'README.md')
  if (!fs.existsSync(readmePath)) return { source: null, text: null }
  return { source: 'README.md', text: readmeSummary(readmePath) || null }
}

function parseCodeowners(repoDir) {
  const found = firstExisting(repoDir, CODEOWNERS_CANDIDATES)
  if (!found) return { present: false, file: null, rules: [], owners: [] }
  const rules = []
  const allOwners = new Set()
  for (const rawLine of fs.readFileSync(found, 'utf8').split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const [pattern, ...owners] = line.split(/\s+/)
    for (const owner of owners) allOwners.add(owner)
    rules.push({ pattern, owners })
  }
  return {
    present: true,
    file: path.relative(repoDir, found),
    rules,
    owners: [...allOwners].sort(),
  }
}

function readCoverage(repoDir) {
  const summaryPath = firstExisting(repoDir, COVERAGE_CANDIDATES)
  if (summaryPath) {
    const source = path.relative(repoDir, summaryPath)
    const total = readJson(summaryPath)?.total
    if (!total) return { lines: null, statements: null, source, note: 'present but no total block' }
    return {
      lines: total.lines?.pct ?? null,
      statements: total.statements?.pct ?? null,
      source,
    }
  }
  if (fs.existsSync(path.join(repoDir, 'coverage'))) {
    return { lines: null, statements: null, source: 'coverage/', note: 'dir exists, no summary json' }
  }
  return null
}

function testStats(repoDir) {
  const relativeFiles = listFiles(repoDir).map((file) => path.relative(repoDir, file))
  const count = (regex) => relativeFiles.filter((file) => regex.test(file)).length
  const testFiles = count(/\.test\.[cm]?[jt]sx?$/)
  const specFiles = count(/\.spec\.[cm]?[jt]sx?$/)
  // In a repo with a Playwright config, the .spec files are Playwright specs.
  const hasPlaywright = PLAYWRIGHT_CONFIGS.some((config) => fs.existsSync(path.join(repoDir, config)))
  return {
    unitTest: testFiles,
    unitSpec: specFiles,
    unitTotal: testFiles + specFiles,
    stories: count(/\.stories\.[cm]?[jt]sx?$/),
    snapshots: count(/\.snap$/),
    playwrightSpecs: hasPlaywright ? specFiles : null,
    coverage: readCoverage(repoDir),
  }
}

function gatherRepo(repo) {
  const repoDir = path.join(ROOT, repo)
  const packageJson = readJson(path.join(repoDir, 'package.json'))
  const tests = testStats(repoDir)
  return {
    purpose: purpose(repoDir, packageJson),
    codeowners: parseCodeowners(repoDir),
    tests,
  }
}

const extras = {}
for (const repo of repos.feInOrg) extras[repo] = gatherRepo(repo)

fs.writeFileSync(path.join(AUDIT, 'scripts/extras-mid.json'), JSON.stringify(extras, null, 2))
for (const [repo, repoExtras] of Object.entries(extras)) {
  console.log(
    repo.padEnd(REPO_COLUMN_WIDTH),
    'tests:',
    String(repoExtras.tests.unitTotal).padStart(COUNT_COLUMN_WIDTH),
    'stories:',
    String(repoExtras.tests.stories).padStart(COUNT_COLUMN_WIDTH),
    'CODEOWNERS:',
    repoExtras.codeowners.present ? 'yes' : 'NO',
  )
}
