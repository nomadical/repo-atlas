// Static + token-gated-data server for the map. Build the image from this repo's Dockerfile and run
// it wherever you run containers, behind whatever ingress you use, at BASE_PATH.
//
// It serves the built viz under the base path and exposes the architecture data ONLY to callers
// with a valid Keycloak bearer token (AUTH_ISSUER) — real data protection, unlike the static AES
// passphrase gate the public GitHub Pages copy falls back to.
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { fileStore } from '../golden-path/lib/store.mjs'
import { blobStore } from './blob-store.mjs'
import { authorFrom, mayCurate } from '../golden-path/lib/identity.mjs'
import { validateEntry, buildEntry } from '../golden-path/lib/decision-log.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const GP_DIR = path.join(DIR, '..', 'golden-path')
const PORT = process.env.PORT || 8080
const BASE = process.env.BASE_PATH || '/repo-atlas'
// Keycloak realm issuer, e.g. https://id.example.com/realms/my-realm. No default: a wrong issuer
// silently fails every token, so the server refuses to start rather than guess one.
const ISSUER = process.env.AUTH_ISSUER
if (!ISSUER) { console.error('server: AUTH_ISSUER is required (your Keycloak realm issuer URL)'); process.exit(1) }
// Origins allowed to fetch /data cross-origin with a bearer token (the viz is hosted on Pages /
// Front Door, this server is on another host). Override with CORS_ORIGINS (comma-separated).
// localhost origins only outside production (local viz against a dev-env server); the deployed
// allowlist shouldn't grant CORS approval to arbitrary pages on a developer's own ports. A prod
// deployment that genuinely needs it can add them via CORS_ORIGINS.
const LOCAL_ORIGINS = process.env.NODE_ENV === 'production' ? '' : ',http://localhost:5173,http://localhost:5180'
// Defaults to same-origin only (empty list): the viz this server itself hosts needs no CORS entry.
// Add the origins of any *separately* hosted copy — your Pages site, your own domain — to
// CORS_ORIGINS, comma-separated.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || LOCAL_ORIGINS.replace(/^,/, ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/protocol/openid-connect/certs`))

// Merged data, read once at startup. The image is rebuilt to pick up a data refresh.
const data = (() => {
  const main = JSON.parse(fs.readFileSync(path.join(DIR, 'fe-architecture.json'), 'utf8'))
  let extras = null
  try { extras = JSON.parse(fs.readFileSync(path.join(DIR, 'fe-architecture-extras.json'), 'utf8')) } catch {}
  let config = null // app config (editable page title) — admin-curated, not pipeline output
  try { config = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')) } catch {}
  // Raw inventory-extra + service-map so the Admin panel's Documentation and Services tabs work in
  // this read-only deploy (they're merged away / not on a repo). Mirror bundle.mjs's payload shape.
  let inventoryExtra = null
  try { inventoryExtra = JSON.parse(fs.readFileSync(path.join(DIR, 'inventory-extra.json'), 'utf8')) } catch {}
  let serviceMap = null
  try { serviceMap = JSON.parse(fs.readFileSync(path.join(DIR, 'service-map.json'), 'utf8')) } catch {}
  return { ...main, extras, config, inventoryExtra, serviceMap }
})()

// Optional role gate: when AUTH_READ_ROLE is set (e.g. ATLAS_READ), a valid token must ALSO carry
// that role — realm-level (realm_access.roles) or on any client (resource_access.*.roles) — else
// 403 (distinct from 401 so the viz can tell "sign in again" from "ask for the role"). Unset →
// any valid realm token reads (the pre-gating behavior; flip the env once the role is rolled out).
const READ_ROLE = (process.env.AUTH_READ_ROLE || '').trim()

// Optional audience gate: when AUTH_AUDIENCE is set, the token's aud must include it — narrows
// /data from "any token minted on the realm" to tokens minted for this app (closes the
// confused-deputy replay of a token another backend received). Unset → realm-wide (default).
const AUDIENCE = (process.env.AUTH_AUDIENCE || '').trim()

// Validate a realm bearer token: JWKS signature + issuer + expiry (+ audience when configured).
// A token FAULT (bad signature, expired, wrong issuer/audience) → 401 so the viz re-authenticates.
// A verification-infrastructure fault (JWKS fetch to the issuer timing out / unreachable) → 503:
// the caller's token may be perfectly valid, and answering 401 would log every user out and drop
// the viz to its static fallback during a Keycloak blip. Missing the read role → 403.
const TOKEN_FAULT_CODES = new Set([
  'ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWT_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'ERR_JWS_INVALID', 'ERR_JWKS_NO_MATCHING_KEY',
])
async function requireAuth(req, res, next) {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : null
  if (!token) return res.status(401).json({ error: 'missing bearer token' })
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER, ...(AUDIENCE ? { audience: AUDIENCE } : {}) })
    req.claims = payload            // the ONLY source of identity downstream; never the body
    if (READ_ROLE) {
      const roles = new Set([
        ...(payload.realm_access?.roles || []),
        ...Object.values(payload.resource_access || {}).flatMap((r) => r.roles || []),
      ])
      if (!roles.has(READ_ROLE)) return res.status(403).json({ error: `missing required role ${READ_ROLE}` })
    }
    next()
  } catch (e) {
    if (TOKEN_FAULT_CODES.has(e?.code)) return res.status(401).json({ error: 'invalid token' })
    console.error('token verification unavailable (JWKS fetch?):', e?.code || e?.message || e)
    res.status(503).json({ error: 'token verification temporarily unavailable — retry' })
  }
}

const app = express()

// CORS: the bearer-token data fetch is cross-origin (viz on Pages/Front Door -> this host), which
// triggers a preflight for the Authorization header. Echo allowlisted origins; answer OPTIONS early
// (preflights carry no token, so this runs before requireAuth). No credentials — token is a header.
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type')
    res.setHeader('Access-Control-Max-Age', '600')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

const router = express.Router()

router.get('/data', requireAuth, (_req, res) => res.json(data))

// Same gate as /data, deliberately NOT static: these list the whole estate's scan results.
const goldenPath = (file) => {
  try { return fs.readFileSync(path.join(GP_DIR, file), 'utf8') } catch { return null }
}
const history = goldenPath('history.json')
const rules = goldenPath('rules.json')
const sendJson = (body, missing) => (_req, res) =>
  body ? res.type('application/json').send(body) : res.status(404).json({ error: missing })
router.get('/golden-path/history', requireAuth, sendJson(history, 'no nightly history in this build'))
router.get('/golden-path/rules', requireAuth, sendJson(rules, 'no rules document in this build'))

// Empty GP_CURATORS means nobody curates: fail closed. The container filesystem is not durable,
// so a deployment sets GP_DECISION_LOG; the in-image default only makes the route testable.
const CURATORS = (process.env.GP_CURATORS || '').split(',').map((s) => s.trim()).filter(Boolean)
// An https:// value is an Azure append-blob URL (auth via managed identity); anything else is a file path.
const DECISION_LOG = process.env.GP_DECISION_LOG || path.join(GP_DIR, 'exceptions.jsonl')
const decisionLogStore = DECISION_LOG.startsWith('https://') ? blobStore({ url: DECISION_LOG }) : fileStore({ path: DECISION_LOG })

// mayCurate is a courtesy for hiding controls; the gate is on the POST below.
router.get('/api/exceptions', requireAuth, async (req, res) => {
  try {
    res.json({ entries: await decisionLogStore.list(), mayCurate: mayCurate(req.claims, CURATORS) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/api/exceptions', requireAuth, express.json({ limit: '64kb' }), async (req, res) => {
  // 403, not 401: the token is valid, the person is not a curator — the page tells those apart.
  if (!mayCurate(req.claims, CURATORS)) {
    return res.status(403).json({ error: 'not a curator: needs a verified address from GP_CURATORS' })
  }
  const invalid = validateEntry(req.body)
  if (invalid) return res.status(400).json({ error: invalid })
  const entry = buildEntry(req.body, authorFrom(req.claims))   // author from the token, never the body
  try { res.status(201).json(await decisionLogStore.append(entry)) }
  catch (err) { res.status(500).json({ error: `could not append to the decision log: ${err.message}` }) }
})

// Health + readiness, under the base path so they're reachable through Traefik (which only routes
// /repo-atlas/*). Readiness reports data freshness — the data is baked into the image, so its
// age == time since the last successful build+deploy, letting monitoring catch a stalled nightly.
router.get('/health', (_req, res) => res.json({ status: 'ok' }))
router.get('/readiness', (_req, res) => {
  const generatedAt = data.generatedAt || null
  const ageHours = generatedAt ? Math.round((Date.now() - new Date(generatedAt).getTime()) / 3600000) : null
  // unauthenticated (monitoring probes carry no token) — expose only the freshness signal, not
  // generatedAt/repo count (org-size + pipeline-cadence metadata for anyone who finds the URL)
  res.json({ status: 'ok', ageHours })
})

const dist = path.join(DIR, 'dist')
router.use(express.static(dist))
// SPA fallback (view state lives in the query string, so this just serves index.html).
router.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))

app.use(BASE, router)
app.get('/health', (_req, res) => res.json({ status: 'ok' })) // also at root for in-container checks

app.listen(PORT, () => {
  console.log(JSON.stringify({ msg: 'repo-atlas up', port: Number(PORT), base: BASE, issuer: ISSUER, repos: data.repos?.length ?? null, generatedAt: data.generatedAt || null, goldenPath: { history: !!history, rules: !!rules, curators: CURATORS.length, decisionLog: process.env.GP_DECISION_LOG ? 'external' : 'in-image' } }))
  // Nothing else in the running system says that approvals are about to be lost on restart.
  if (!process.env.GP_DECISION_LOG && CURATORS.length) {
    console.warn('WARNING: GP_DECISION_LOG is unset — curated decisions are written inside the image and will be lost on restart')
  }
  // The wide-open default is documented (infra/keycloak.md) but easy to forget once the role exists.
  if (!READ_ROLE) {
    console.warn('WARNING: AUTH_READ_ROLE is unset — every valid realm token (any user, any client) can read /data; set it (e.g. ATLAS_READ) once the role is rolled out')
  }
})
