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
  'scripts/extras-assemble.mjs',
]
const SCRATCH = ['scripts/gather-out.json','scripts/workflows-out.json','scripts/modulegraph-out.json','scripts/extras-mid.json','scripts/depcruise-out.json']

function readMergedData() {
  const main = JSON.parse(fs.readFileSync(path.join(AUDIT, 'fe-architecture.json'), 'utf8'))
  let extras = null
  try { extras = JSON.parse(fs.readFileSync(path.join(AUDIT, 'fe-architecture-extras.json'), 'utf8')) } catch {}
  let config = null // app config (editable page title) — admin-curated, not pipeline output
  try { config = JSON.parse(fs.readFileSync(path.join(AUDIT, 'config.json'), 'utf8')) } catch {}
  // Raw inventory-extra so the Admin panel can edit Documentation in read-only deploys (see bundle.mjs)
  let inventoryExtra = null
  try { inventoryExtra = JSON.parse(fs.readFileSync(path.join(AUDIT, 'inventory-extra.json'), 'utf8')) } catch {}
  // Raw service-map so the Admin panel's Services tab is populated (see bundle.mjs)
  let serviceMap = null
  try { serviceMap = JSON.parse(fs.readFileSync(path.join(AUDIT, 'service-map.json'), 'utf8')) } catch {}
  return { ...main, extras, config, inventoryExtra, serviceMap }
}

const json = (res, code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)) }

// Curation files the Admin panel reads/writes. Allowlisted so a crafted request can't write an
// arbitrary path. JSON files are pretty-printed; the integrations file is raw CSV text.
const CURATION = {
  backendExtra: { file: 'backend-extra.json', json: true },
  inventoryExtra: { file: 'inventory-extra.json', json: true },
  integrationsCsv: { file: 'integrations.csv', json: false },
  config: { file: 'config.json', json: true },
  serviceMap: { file: 'service-map.json', json: true },
}
const readJsonBody = (req) => new Promise((resolve, reject) => {
  let d = ''
  req.on('data', (c) => { d += c; if (d.length > 8 * 1024 * 1024) { req.destroy(); reject(new Error('body too large')) } })
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}) } catch (e) { reject(e) } })
  req.on('error', reject)
})

async function runPipeline() {
  const log = []
  for (const script of PIPELINE) {
    const started = Date.now()
    try {
      const { stdout, stderr } = await execFileP('node', [script], { cwd: AUDIT, maxBuffer: 1024 * 1024 * 256 })
      log.push({ script, ok: true, ms: Date.now() - started, out: (stdout || stderr || '').trim().split('\n').slice(-2).join(' ') })
    } catch (e) {
      log.push({ script, ok: false, ms: Date.now() - started, out: String(e.stderr || e.message || e).slice(-300) })
      return { ok: false, log }
    }
  }
  for (const f of SCRATCH) { try { fs.unlinkSync(path.join(AUDIT, f)) } catch {} }
  return { ok: true, log }
}

async function publish() {
  // build the static app
  await execFileP('npm', ['run', 'build'], { cwd: __dirname, maxBuffer: 1024 * 1024 * 256 })
  // bake current data into the static bundle so the published copy needs no server
  const dist = path.join(__dirname, 'dist')
  fs.writeFileSync(path.join(dist, 'data.json'), JSON.stringify(readMergedData()))
  // copy dist -> ../published
  const out = path.join(AUDIT, 'published')
  fs.rmSync(out, { recursive: true, force: true })
  fs.cpSync(dist, out, { recursive: true })
  return out
}

function apiPlugin() {
  return {
    name: 'fe-arch-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          // CSRF gate: the write/exec endpoints below are otherwise reachable by a "simple"
          // cross-site POST (no preflight) from any page open in the developer's browser —
          // overwriting curation files or spawning the pipeline. Browsers always send Origin on
          // POST; absent Origin means a non-browser client (curl), which is fine for local dev.
          if (req.method === 'POST') {
            const origin = req.headers.origin
            if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
              return json(res, 403, { error: `cross-origin request rejected (origin ${origin})` })
            }
          }
          if (req.url === '/api/data' && req.method === 'GET') return json(res, 200, readMergedData())
          // Admin panel: raw curation files (so it can edit inventory-extra.json, which is merged
          // away in the served data) and a write-back endpoint.
          if (req.url === '/api/curation' && req.method === 'GET') {
            const read = (f) => { try { return fs.readFileSync(path.join(AUDIT, f), 'utf8') } catch { return null } }
            const out = {}
            for (const [key, { file, json: isJson }] of Object.entries(CURATION)) {
              const raw = read(file)
              out[key] = raw == null ? null : isJson ? JSON.parse(raw) : raw
            }
            return json(res, 200, out)
          }
          if (req.url === '/api/save-curation' && req.method === 'POST') {
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
          // In production these are token-gated routes in server/server.mjs; here, files on disk.
          if (req.url === '/golden-path/history' && req.method === 'GET') {
            return json(res, 200, JSON.parse(fs.readFileSync(path.join(GOLDEN_PATH, 'history.json'), 'utf8')))
          }
          if (req.url === '/golden-path/rules' && req.method === 'GET') {
            return json(res, 200, JSON.parse(fs.readFileSync(path.join(GOLDEN_PATH, 'rules.json'), 'utf8')))
          }
          /* Same store and validation as production, so a decision written in dev is one production
             would have accepted. No curator check: there is no verified token here. GP_DEV_VIEWER=true
             answers mayCurate false, to see what a reader without the right sees. */
          if (req.url === '/api/exceptions' && req.method === 'GET') {
            return json(res, 200, { entries: [...decisionLog.list(), ...devDecisionLog.list()], mayCurate: process.env.GP_DEV_VIEWER !== 'true' })
          }
          if (req.url === '/api/exceptions' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const invalid = validateEntry(body)
            if (invalid) return json(res, 400, { error: invalid })
            return json(res, 201, devDecisionLog.append(buildEntry(body, process.env.USER || 'unknown')))
          }
          if (req.url === '/api/regenerate' && req.method === 'POST') {
            const result = await runPipeline()
            return json(res, result.ok ? 200 : 500, result)
          }
          if (req.url === '/api/publish' && req.method === 'POST') {
            const out = await publish()
            return json(res, 200, { ok: true, path: out })
          }
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) })
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
