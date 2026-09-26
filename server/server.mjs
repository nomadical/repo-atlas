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
const MS_PER_HOUR = 3600000

const commaList = (value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

// Keycloak realm issuer, e.g. https://id.example.com/realms/my-realm. No default: a wrong issuer
// silently fails every token, so the server refuses to start rather than guess one.
const ISSUER = process.env.AUTH_ISSUER
if (!ISSUER) {
  console.error('server: AUTH_ISSUER is required (your Keycloak realm issuer URL)')
  process.exit(1)
}

// Origins allowed to fetch /data cross-origin with a bearer token, for a separately hosted copy of
// the viz (Pages, your own domain); the viz this server hosts itself needs no entry. Override with
// CORS_ORIGINS (comma-separated). The localhost defaults apply only outside production: the deployed
// allowlist shouldn't approve arbitrary pages on a developer's own ports.
const LOCAL_ORIGINS =
  process.env.NODE_ENV === 'production' ? [] : ['http://localhost:5173', 'http://localhost:5180']
const CORS_ORIGINS = process.env.CORS_ORIGINS ? commaList(process.env.CORS_ORIGINS) : LOCAL_ORIGINS

const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/protocol/openid-connect/certs`))

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'))

function readOptionalJson(file) {
  try {
    return readJson(file)
  } catch {
    return null
  }
}

// Merged data, read once at startup. The image is rebuilt to pick up a data refresh.
// Mirrors bundle.mjs's payload: the raw inventory-extra and service-map let the Admin panel's
// Documentation and Services tabs work in this read-only deploy, and config is the admin-curated
// page title.
function readMergedData() {
  const main = readJson('fe-architecture.json')
  const extras = readOptionalJson('fe-architecture-extras.json')
  const config = readOptionalJson('config.json')
  const inventoryExtra = readOptionalJson('inventory-extra.json')
  const serviceMap = readOptionalJson('service-map.json')
  return { ...main, extras, config, inventoryExtra, serviceMap }
}

const data = readMergedData()

// Optional role gate: when AUTH_READ_ROLE is set (e.g. ATLAS_READ), a valid token must also carry
// that role, realm-level or on any client. Unset, any valid realm token reads.
const READ_ROLE = (process.env.AUTH_READ_ROLE || '').trim()

// Optional audience gate: when AUTH_AUDIENCE is set, the token's aud must include it. That narrows
// /data to tokens minted for this app and closes the confused-deputy replay of a token another
// backend received. Unset, the gate is realm-wide.
const AUDIENCE = (process.env.AUTH_AUDIENCE || '').trim()

// Errors that mean the token itself is bad, so the viz should re-authenticate (401). Anything else
// is the verification infrastructure (JWKS fetch timing out): the token may be valid, and a 401
// would log every user out during a Keycloak blip, so that answers 503.
const TOKEN_FAULT_CODES = new Set([
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWS_INVALID',
  'ERR_JWKS_NO_MATCHING_KEY',
])

const BEARER_PREFIX = 'Bearer '

function bearerToken(req) {
  const header = req.headers.authorization || ''
  return header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : null
}

function rolesOf(payload) {
  const clientRoles = Object.values(payload.resource_access || {}).flatMap((client) => client.roles || [])
  return new Set([...(payload.realm_access?.roles || []), ...clientRoles])
}

// JWKS signature + issuer + expiry (+ audience when configured). A missing read role is 403, not
// 401, so the viz can tell "sign in again" from "ask for the role".
async function requireAuth(req, res, next) {
  const token = bearerToken(req)
  if (!token) return res.status(401).json({ error: 'missing bearer token' })
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      ...(AUDIENCE ? { audience: AUDIENCE } : {}),
    })
    // The only source of identity downstream; never the body.
    req.claims = payload
    if (READ_ROLE && !rolesOf(payload).has(READ_ROLE)) {
      return res.status(403).json({ error: `missing required role ${READ_ROLE}` })
    }
    next()
  } catch (error) {
    if (TOKEN_FAULT_CODES.has(error?.code)) return res.status(401).json({ error: 'invalid token' })
    console.error('token verification unavailable (JWKS fetch?):', error?.code || error?.message || error)
    res.status(503).json({ error: 'token verification temporarily unavailable — retry' })
  }
}

// The bearer-token fetch from a separately hosted viz is cross-origin and preflighted for the
// Authorization header. Preflights carry no token, so OPTIONS is answered here, before requireAuth.
// No credentials: the token travels as a header.
function cors(req, res, next) {
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
}

const app = express()
app.use(cors)

const router = express.Router()

router.get('/data', requireAuth, (_req, res) => res.json(data))

function readGoldenPathFile(file) {
  try {
    return fs.readFileSync(path.join(GP_DIR, file), 'utf8')
  } catch {
    return null
  }
}

const sendJsonText = (body, missingMessage) => (_req, res) => {
  if (!body) return res.status(404).json({ error: missingMessage })
  res.type('application/json').send(body)
}

// Same gate as /data, deliberately not static: these list the whole estate's scan results.
const history = readGoldenPathFile('history.json')
const rules = readGoldenPathFile('rules.json')
router.get('/golden-path/history', requireAuth, sendJsonText(history, 'no run history in this build'))
router.get('/golden-path/rules', requireAuth, sendJsonText(rules, 'no rules document in this build'))

// Empty GP_CURATORS means nobody curates: fail closed.
const CURATORS = commaList(process.env.GP_CURATORS || '')

// The container filesystem is not durable, so a deployment sets GP_DECISION_LOG; the in-image
// default only makes the route testable. An https:// value is an Azure append-blob URL (auth via
// managed identity); anything else is a file path.
const DECISION_LOG = process.env.GP_DECISION_LOG || path.join(GP_DIR, 'exceptions.jsonl')
const decisionLogStore = DECISION_LOG.startsWith('https://')
  ? blobStore({ url: DECISION_LOG })
  : fileStore({ path: DECISION_LOG })

// mayCurate is a courtesy for hiding controls; the gate is on the POST below.
router.get('/api/exceptions', requireAuth, async (req, res) => {
  try {
    res.json({ entries: await decisionLogStore.list(), mayCurate: mayCurate(req.claims, CURATORS) })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

router.post('/api/exceptions', requireAuth, express.json({ limit: '64kb' }), async (req, res) => {
  // 403, not 401: the token is valid, the person is not a curator — the page tells those apart.
  if (!mayCurate(req.claims, CURATORS)) {
    return res.status(403).json({ error: 'not a curator: needs a verified address from GP_CURATORS' })
  }
  const invalid = validateEntry(req.body)
  if (invalid) return res.status(400).json({ error: invalid })
  // The author comes from the token, never the body.
  const entry = buildEntry(req.body, authorFrom(req.claims))
  try {
    res.status(201).json(await decisionLogStore.append(entry))
  } catch (error) {
    res.status(500).json({ error: `could not append to the decision log: ${error.message}` })
  }
})

const hoursSince = (timestamp) => Math.round((Date.now() - new Date(timestamp).getTime()) / MS_PER_HOUR)

// Under the base path so they're reachable through an ingress that only routes /repo-atlas/*.
// The data is baked into the image, so its age is the time since the last successful build and
// deploy, which lets monitoring catch data that has gone stale.
router.get('/health', (_req, res) => res.json({ status: 'ok' }))
router.get('/readiness', (_req, res) => {
  const generatedAt = data.generatedAt || null
  const ageHours = generatedAt ? hoursSince(generatedAt) : null
  // Unauthenticated (probes carry no token), so only the freshness signal: generatedAt and the
  // repo count would leak org size and pipeline cadence to anyone who finds the URL.
  res.json({ status: 'ok', ageHours })
})

const dist = path.join(DIR, 'dist')
router.use(express.static(dist))
// SPA fallback (view state lives in the query string, so this just serves index.html).
router.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))

app.use(BASE, router)
// Also at the root, for in-container checks.
app.get('/health', (_req, res) => res.json({ status: 'ok' }))

function logStartup() {
  console.log(
    JSON.stringify({
      msg: 'repo-atlas up',
      port: Number(PORT),
      base: BASE,
      issuer: ISSUER,
      repos: data.repos?.length ?? null,
      generatedAt: data.generatedAt || null,
      goldenPath: {
        history: !!history,
        rules: !!rules,
        curators: CURATORS.length,
        decisionLog: process.env.GP_DECISION_LOG ? 'external' : 'in-image',
      },
    }),
  )
  // Nothing else in the running system says that approvals are about to be lost on restart.
  if (!process.env.GP_DECISION_LOG && CURATORS.length) {
    console.warn(
      'WARNING: GP_DECISION_LOG is unset — curated decisions are written inside the image and will be lost on restart',
    )
  }
  // The wide-open default is documented (infra/keycloak.md) but easy to forget once the role exists.
  if (!READ_ROLE) {
    console.warn(
      'WARNING: AUTH_READ_ROLE is unset — every valid realm token (any user, any client) can read /data; set it (e.g. ATLAS_READ) once the role is rolled out',
    )
  }
}

app.listen(PORT, logStartup)
