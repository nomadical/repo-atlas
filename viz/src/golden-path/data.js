import { getToken } from '../auth.js'

/* The same closed data as the model, read the same way: token-gated routes, never the openly served
   static bundle. All routes are siblings of /data: in production VITE_DATA_URL carries the base path
   Traefik routes on, so a root-absolute URL would never reach the service. In dev the var is unset,
   getToken() returns null, and the vite middleware serves the same paths unsigned. */
const DATA_URL = import.meta.env.VITE_DATA_URL
const siblingOfData = (path) => (DATA_URL ? DATA_URL.replace(/\/data$/, path) : path)
const HISTORY_URL = siblingOfData('/golden-path/history')
const RULES_URL = siblingOfData('/golden-path/rules')
const DECISION_LOG_URL = siblingOfData('/api/exceptions')

function withAuth(init) {
  const token = getToken()
  if (!token) return init
  return { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } }
}

const isJson = (response) => (response.headers.get('content-type') || '').toLowerCase().includes('json')

// The one fetch that must succeed. The messages are user-facing: a 401 means the session did not
// carry through, which calls for a reload, not a bug report.
export async function loadHistory() {
  const response = await fetch(HISTORY_URL, withAuth())
  if (response.status === 401 || response.status === 403) {
    throw new Error('Not signed in — reload the page to sign in again.')
  }
  if (!response.ok) throw new Error(`The run history could not be loaded (${response.status}).`)
  // A server without this route answers 200 with the SPA's index.html (the static fallback).
  if (!isJson(response)) {
    throw new Error(
      'This deployment does not serve the Golden Path data yet — it predates the screen. Redeploy the service and reload.',
    )
  }
  return response.json()
}

// Null when unreadable: the rules library keeps its fallback and the screen claims no revision it
// has not seen.
export async function loadRules() {
  try {
    const response = await fetch(RULES_URL, withAuth())
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

// The decisions, and whether this reader may add one. Null, not an empty result, when the log cannot
// be read: "unreachable" and "nothing in it" are different answers on screen.
export async function loadExceptions() {
  try {
    const response = await fetch(DECISION_LOG_URL, withAuth())
    if (!response.ok) return null
    const body = await response.json()
    return { entries: body.entries || [], mayCurate: body.mayCurate === true }
  } catch {
    return null
  }
}

// The only place a curated decision leaves the browser.
export async function appendException(entry) {
  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(entry),
  }
  const response = await fetch(DECISION_LOG_URL, withAuth(request))
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `save failed (${response.status})`)
  }
  return response.json()
}
