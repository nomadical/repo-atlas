// Endpoint extraction shared by the repo-level pass (gather-arch.mjs, over ripgrep output) and the
// per-screen pass (screens-gather.mjs, over one file's text), so both attribute the same
// `use<Name>Endpoints('path')` literals with identical normalization.

// Drops conditional template fragments, collapses simple interpolations to {id}, squeezes
// slashes and trims leading/trailing ones.
export const normalizeEndpoint = (raw) =>
  raw
    .replace(/\$\{[^}]*\?[^}]*\}/g, '')
    .replace(/\$\{[^}]*\}/g, '{id}')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/|\/$/g, '')
    .trim()

// use<Name>Endpoints('resource/path'): single, double or backtick quoted, possibly multiline.
const HOOK_CALLS = [
  /use[A-Za-z]+Endpoints\(\s*`([^`]*)`/g,
  /use[A-Za-z]+Endpoints\(\s*'([^']*)'/g,
  /use[A-Za-z]+Endpoints\(\s*"([^"]*)"/g,
]

const firstGroups = (regex, text) => [...text.matchAll(regex)].map((match) => match[1])

const isHookEndpoint = (endpoint) => endpoint && !/^[?:&|.]/.test(endpoint) && /[a-z]/i.test(endpoint)

export const extractEndpointsFromText = (text, set = new Set()) => {
  for (const regex of HOOK_CALLS) {
    for (const raw of firstGroups(regex, text)) {
      const endpoint = normalizeEndpoint(raw)
      if (isHookEndpoint(endpoint)) set.add(endpoint)
    }
  }
  return set
}

const ASSET_FILE = /\.(svg|png|jpe?g|gif|ico|css|js|json|woff2?|ttf|map)$/i

// Same shape as the hook endpoints: host, protocol and query stripped, ${…} -> {id}, a leading
// base-URL variable dropped. Returns null for anything that isn't path-like.
function apiPathFrom(raw) {
  const withoutBase = String(raw)
    .trim()
    .replace(/^\s*\$\{[^}]*\}/, '')
    .replace(/^https?:\/\/[^/]+/i, '')
  const endpoint = normalizeEndpoint(withoutBase.split(/[?#]/)[0])
  if (!/^[a-z][\w./{}:-]*$/i.test(endpoint)) return null
  if (ASSET_FILE.test(endpoint)) return null
  if (!/[a-z]/i.test(endpoint)) return null
  // A bare version like "v1" is a base URL, not an endpoint.
  if (/^v\d+$/i.test(endpoint)) return null
  return endpoint
}

// A template URL built off a *Url/Api/Base/Host variable: `${SKYGATE_URL}gateway/{id}`
const TEMPLATE_URL =
  /`\s*\$\{[A-Za-z0-9_]*(?:URL|Url|API|Api|BASE|Base|HOST|Host|ENDPOINT|Endpoint)[A-Za-z0-9_]*\}([^`]+)`/g

// Anchored on real call syntax so react-router paths and arbitrary strings aren't picked up.
const API_CALLS = [
  /\b(?:fetch|axios)\s*\(\s*[`'"]([^`'"]+)[`'"]/g,
  // client.get('…'), api.post(`…`), http.put("…"), .delete / .patch / .request
  /\.\s*(?:get|post|put|patch|delete|request)\s*\(\s*[`'"]([^`'"]+)[`'"]/g,
  TEMPLATE_URL,
]

function addApiPaths(regex, text, set) {
  for (const raw of firstGroups(regex, text)) {
    const endpoint = apiPathFrom(raw)
    if (endpoint) set.add(endpoint)
  }
}

// Per-screen tracer only; gather-arch keeps its repo-level hook/URL behavior.
export const extractApiCallsFromText = (text, set = new Set()) => {
  for (const regex of API_CALLS) addApiPaths(regex, text, set)
  return set
}

// For clients that call their endpoints hook with no argument and keep the paths in the hook
// definition (`${apiUrl}/loggers/search`): there is no quoted hook argument and no literal host.
export const extractTemplateEndpointsFromText = (text, set = new Set()) => {
  addApiPaths(TEMPLATE_URL, text, set)
  return set
}

const URL_NOISE =
  /atlassian|sharepoint|stoplight|webhook\.office|\/wiki|\/terms|\.(svg|png|pdf|jpe?g|gif|ico)/
// Same env-token list as backend-scan.mjs / assemble.mjs / guard-data.mjs.
const ENV_INFIX = /\.(dev|test|pre|prod|demo|poc|nonprod|sandbox|e2e)(?=\.)/g

// Fallback over grepped backend URLs, one per line of `text`.
export const extractUrlEndpointsFromText = (text, set = new Set()) => {
  for (const rawLine of text.split('\n')) {
    const url = rawLine.trim()
    if (!url || URL_NOISE.test(url)) continue
    set.add(url.replace(ENV_INFIX, '.{env}').replace(/["')\\,;]+$/, ''))
  }
  return set
}
