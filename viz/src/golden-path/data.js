import { getToken } from '../auth.js'

/* The same closed data as the model, read the same way: token-gated routes, never the static
   bundle, which is served openly. All three are siblings of /data and derived from it — in
   production VITE_DATA_URL carries the base path Traefik routes on, and a root-absolute URL would
   never reach the service. In dev the var is unset, getToken() returns null, and the vite
   middleware serves the same paths unsigned. */
const DATA_URL = import.meta.env.VITE_DATA_URL
const sibling = (p) => (DATA_URL ? DATA_URL.replace(/\/data$/, p) : p)
const HISTORY_URL = sibling('/golden-path/history')
const RULES_URL = sibling('/golden-path/rules')
const DECISION_LOG_URL = sibling('/api/exceptions')

const authed = (init) => {
  const token = getToken()
  return token ? { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } } : init
}

// The one fetch that must succeed. The message is user-facing: 401 means the session did not carry
// through, which is a reload, not a bug report.
export async function loadHistory() {
  const r = await fetch(HISTORY_URL, authed())
  if (r.status === 401 || r.status === 403) throw new Error('Not signed in — reload the page to sign in again.')
  if (!r.ok) throw new Error(`The nightly history could not be loaded (${r.status}).`)
  // A server without this route answers 200 with the SPA's index.html (the static fallback).
  if (!(r.headers.get('content-type') || '').toLowerCase().includes('json')) {
    throw new Error('This deployment does not serve the Golden Path data yet — it predates the screen. Redeploy the service and reload.')
  }
  return r.json()
}

// Null when unreadable: the rules library keeps its fallback and the screen claims no revision it
// has not seen.
export async function loadRules() {
  try {
    const r = await fetch(RULES_URL, authed())
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

/* The decisions, and whether this reader may add one. Null — not an empty result — when the decision log
   cannot be read: "unreachable" and "nothing in it" are different answers on screen. */
export async function loadExceptions() {
  try {
    const r = await fetch(DECISION_LOG_URL, authed())
    if (!r.ok) return null
    const body = await r.json()
    return { entries: body.entries || [], mayCurate: body.mayCurate === true }
  } catch {
    return null
  }
}

// The single write, and the only place a curated decision leaves the browser.
export async function appendException(entry) {
  const r = await fetch(DECISION_LOG_URL, authed({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) }))
  if (!r.ok) {
    const body = await r.json().catch(() => ({}))
    throw new Error(body.error || `save failed (${r.status})`)
  }
  return r.json()
}
