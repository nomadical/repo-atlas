import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { fileStore } from '../golden-path/lib/store.mjs'
import { validateEntry, buildEntry } from '../golden-path/lib/decision-log.mjs'

const execFileP = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUDIT = path.resolve(__dirname, '..') // the repo root
// Shared with the node tests: the screen reaches it through the @golden-path alias below, this
// config imports the same files directly for the dev routes.
const GOLDEN_PATH = path.join(AUDIT, 'golden-path')
// Reads show the committed decision log, but dev writes land in a gitignored overlay — a curious click
// on Approve/Exclude in `npm run dev` must not append to the production decision log.
const decisionLog = fileStore({ path: path.join(GOLDEN_PATH, 'exceptions.jsonl') })
const devDecisionLog = fileStore({ path: path.join(GOLDEN_PATH, 'exceptions.dev.jsonl') })

// Same order as `npm run regenerate`: backend-scan must run BEFORE assemble, which derives the
// Kafka/REST service links from backend-tooling.json (scanning after would pair a fresh model
// with the previous run's links).
const PIPELINE = [
  'scripts/gather-arch.mjs',
  'scripts/parse-workflows.mjs',
  'scripts/module-graph.mjs',
  'scripts/azure-gather.mjs',
  'scripts/github-inventory.mjs',
  'scripts/sync-names.mjs',
  'scripts/backend-scan.mjs',
  'scripts/assemble.mjs',
  'scripts/extras-gather.mjs',
  'scripts/depcruise-accurate.mjs',
  'scripts/screens-gather.mjs',
  'scripts/extras-assemble.mjs',
  // warns (never fails) when the regenerated files replaced the committed demo with real data
  'scripts/check-demo-data.mjs --warn',
]
const SCRATCH = [
  'scripts/gather-out.json',
  'scripts/workflows-out.json',
  'scripts/modulegraph-out.json',
  'scripts/extras-mid.json',
  'scripts/depcruise-out.json',
  'scripts/screens-out.json',
]

const EXEC_MAX_BUFFER = 256 * 1024 * 1024
const MAX_BODY_CHARS = 8 * 1024 * 1024
const PIPELINE_OUTPUT_LINES = 2
const PIPELINE_ERROR_CHARS = 300
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

const readRepoJson = (file) => JSON.parse(fs.readFileSync(path.join(AUDIT, file), 'utf8'))

function readOptionalRepoJson(file) {
  try {
    return readRepoJson(file)
  } catch {
    return null
  }
}

// Same payload as bundle.mjs. The raw inventory-extra and service-map feed the Admin panel's
// Documentation and Services tabs; config is the admin-curated page title, not pipeline output.
function readMergedData() {
  const main = readRepoJson('fe-architecture.json')
  const extras = readOptionalRepoJson('fe-architecture-extras.json')
  const config = readOptionalRepoJson('config.json')
  const inventoryExtra = readOptionalRepoJson('inventory-extra.json')
  const serviceMap = readOptionalRepoJson('service-map.json')
  return { ...main, extras, config, inventoryExtra, serviceMap }
}

const json = (res, code, body) => {
  res.statusCode = code
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

// Curation files the Admin panel reads/writes. Allowlisted so a crafted request can't write an
// arbitrary path. JSON files are pretty-printed; the integrations file is raw CSV text.
const CURATION = {
  backendExtra: { file: 'backend-extra.json', json: true },
  inventoryExtra: { file: 'inventory-extra.json', json: true },
  integrationsCsv: { file: 'integrations.csv', json: false },
  config: { file: 'config.json', json: true },
  serviceMap: { file: 'service-map.json', json: true },
}

const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY_CHARS) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })

const lastLines = (text, count) => text.trim().split('\n').slice(-count).join(' ')

async function runScript(script) {
  const started = Date.now()
  const [file, ...args] = script.split(' ')
  try {
    const { stdout, stderr } = await execFileP('node', [file, ...args], {
      cwd: AUDIT,
      maxBuffer: EXEC_MAX_BUFFER,
    })
    const out = lastLines(stdout || stderr || '', PIPELINE_OUTPUT_LINES)
    return { script, ok: true, ms: Date.now() - started, out }
  } catch (error) {
    const out = String(error.stderr || error.message || error).slice(-PIPELINE_ERROR_CHARS)
    return { script, ok: false, ms: Date.now() - started, out }
  }
}

function removeScratchFiles() {
  for (const file of SCRATCH) {
    try {
      fs.unlinkSync(path.join(AUDIT, file))
    } catch {}
  }
}

// Stops at the first failing script and keeps its scratch files for debugging.
async function runPipeline() {
  const log = []
  for (const script of PIPELINE) {
    const step = await runScript(script)
    log.push(step)
    if (!step.ok) return { ok: false, log }
  }
  removeScratchFiles()
  return { ok: true, log }
}

// Builds the static app with the current data baked in, so the published copy needs no server.
async function publish() {
  await execFileP('npm', ['run', 'build'], { cwd: __dirname, maxBuffer: EXEC_MAX_BUFFER })
  const dist = path.join(__dirname, 'dist')
  fs.writeFileSync(path.join(dist, 'data.json'), JSON.stringify(readMergedData()))
  const out = path.join(AUDIT, 'published')
  fs.rmSync(out, { recursive: true, force: true })
  fs.cpSync(dist, out, { recursive: true })
  return out
}

function readCurationFile(file) {
  try {
    return fs.readFileSync(path.join(AUDIT, file), 'utf8')
  } catch {
    return null
  }
}

// Raw curation files, so the Admin panel can edit inventory-extra.json, which is merged away in
// the served data.
function getCuration(_req, res) {
  const curation = {}
  for (const [key, { file, json: isJson }] of Object.entries(CURATION)) {
    const raw = readCurationFile(file)
    if (raw == null) curation[key] = null
    else curation[key] = isJson ? JSON.parse(raw) : raw
  }
  return json(res, 200, curation)
}

async function saveCuration(req, res) {
  const body = await readJsonBody(req)
  const written = []
  for (const [key, { file, json: isJson }] of Object.entries(CURATION)) {
    if (body[key] === undefined || body[key] === null) continue
    const content = isJson ? JSON.stringify(body[key], null, 2) + '\n' : String(body[key])
    fs.writeFileSync(path.join(AUDIT, file), content)
    written.push(file)
  }
  return json(res, 200, { ok: true, written })
}

const readGoldenPathJson = (file) => JSON.parse(fs.readFileSync(path.join(GOLDEN_PATH, file), 'utf8'))

/* Same store and validation as production, so a decision written in dev is one production
   would have accepted. No curator check: there is no verified token here. GP_DEV_VIEWER=true
   answers mayCurate false, to see what a reader without the right sees. */
function listExceptions(_req, res) {
  const entries = [...decisionLog.list(), ...devDecisionLog.list()]
  return json(res, 200, { entries, mayCurate: process.env.GP_DEV_VIEWER !== 'true' })
}

async function appendException(req, res) {
  const body = await readJsonBody(req)
  const invalid = validateEntry(body)
  if (invalid) return json(res, 400, { error: invalid })
  return json(res, 201, devDecisionLog.append(buildEntry(body, process.env.USER || 'unknown')))
}

async function regenerate(_req, res) {
  const result = await runPipeline()
  return json(res, result.ok ? 200 : 500, result)
}

async function publishRoute(_req, res) {
  const out = await publish()
  return json(res, 200, { ok: true, path: out })
}

// "METHOD url" -> handler. The golden-path routes are token-gated in server/server.mjs; here they
// are files on disk.
const ROUTES = new Map([
  ['GET /api/data', (_req, res) => json(res, 200, readMergedData())],
  ['GET /api/curation', getCuration],
  ['POST /api/save-curation', saveCuration],
  ['GET /golden-path/history', (_req, res) => json(res, 200, readGoldenPathJson('history.json'))],
  ['GET /golden-path/rules', (_req, res) => json(res, 200, readGoldenPathJson('rules.json'))],
  ['GET /api/exceptions', listExceptions],
  ['POST /api/exceptions', appendException],
  ['POST /api/regenerate', regenerate],
  ['POST /api/publish', publishRoute],
])

// CSRF gate: the write/exec endpoints are otherwise reachable by a "simple" cross-site POST (no
// preflight) from any page open in the developer's browser. Browsers always send Origin on POST;
// absent Origin means a non-browser client (curl), which is fine for local dev.
function isCrossSitePost(req) {
  if (req.method !== 'POST') return false
  const origin = req.headers.origin
  return !!origin && !LOCAL_ORIGIN.test(origin)
}

function apiPlugin() {
  return {
    name: 'fe-arch-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          if (isCrossSitePost(req)) {
            return json(res, 403, {
              error: `cross-origin request rejected (origin ${req.headers.origin})`,
            })
          }
          const handler = ROUTES.get(`${req.method} ${req.url}`)
          if (handler) return await handler(req, res)
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error.message || error) })
        }
        next()
      })
    },
  }
}

// base './' -> relative asset URLs, so the bundle works at / (published/) AND under
// a sub-path like github.io/repo-atlas/ (GitHub Pages).
export default defineConfig({
  base: './',
  plugins: [react(), apiPlugin()],
  resolve: { alias: { '@golden-path': GOLDEN_PATH } },
  server: { port: 5180, open: false, fs: { allow: [__dirname, GOLDEN_PATH] } },
})
