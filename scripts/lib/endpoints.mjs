// Shared endpoint-extraction logic, used by both the repo-level pass (gather-arch.mjs, via ripgrep
// over a whole src/ tree) and the per-screen pass (screens-gather.mjs, over a single file's text).
// Keeping one implementation guarantees both attribute the same `use<Name>Endpoints('path')` literals
// with identical normalization.

// Normalize one captured endpoint path: drop conditional template fragments, collapse simple
// interpolations to {id}, squeeze slashes, trim leading/trailing slashes.
export const normalizeEndpoint = (raw) =>
  raw
    .replace(/\$\{[^}]*\?[^}]*\}/g, '') // conditional template fragment -> drop
    .replace(/\$\{[^}]*\}/g, '{id}') // simple interpolation -> {id}
    .replace(/\/{2,}/g, '/')
    .replace(/^\/|\/$/g, '')
    .trim()

// use<Name>Endpoints('resource/path') — single / double / backtick quoted, multiline calls.
const HOOK_RES = [
  /use[A-Za-z]+Endpoints\(\s*`([^`]*)`/g,
  /use[A-Za-z]+Endpoints\(\s*'([^']*)'/g,
  /use[A-Za-z]+Endpoints\(\s*"([^"]*)"/g,
]

// Collect endpoint paths from the `use*Endpoints()` hook pattern in `text` into `set`.
export const extractEndpointsFromText = (text, set = new Set()) => {
  for (const re of HOOK_RES) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) {
      const p = normalizeEndpoint(m[1])
      if (p && !/^[?:&|.]/.test(p) && /[a-z]/i.test(p)) set.add(p)
    }
  }
  return set
}

// Broader API-call extraction for the PER-SCREEN tracer only (gather-arch keeps its repo-level
// hook/URL behavior). Anchored on real call syntax — fetch()/axios()/.get|.post|.put|.patch|.delete()
// and template literals built off a *...Url/Api/Base/Host* variable — so it stays API-specific and
// doesn't slurp react-router paths or arbitrary strings. Normalizes to the same shape as the hooks
// (host/protocol/query stripped, ${…} → {id}, leading base-var dropped).
const apiPathFrom = (raw) => {
  let p = String(raw).trim()
  p = p.replace(/^\s*\$\{[^}]*\}/, '') // drop a leading ${BASE_URL} builder prefix
  p = p.replace(/^https?:\/\/[^/]+/i, '') // drop protocol + host if a full URL
  p = p.split(/[?#]/)[0] // drop query / hash
  p = normalizeEndpoint(p)
  // keep path-like values only: starts with a letter, has no spaces, isn't an asset/file name
  if (!/^[a-z][\w./{}:-]*$/i.test(p)) return null
  if (/\.(svg|png|jpe?g|gif|ico|css|js|json|woff2?|ttf|map)$/i.test(p)) return null
  if (!/[a-z]/i.test(p)) return null
  if (/^v\d+$/i.test(p)) return null // bare API version prefix (e.g. "v1") — a base, not an endpoint
  return p
}

// template URL built off a *Url/Api/Base/Host variable: `${SKYGATE_URL}gateway/{id}`
const TEMPLATE_URL_RE = /`\s*\$\{[A-Za-z0-9_]*(?:URL|Url|API|Api|BASE|Base|HOST|Host|ENDPOINT|Endpoint)[A-Za-z0-9_]*\}([^`]+)`/g

const API_CALL_RES = [
  // fetch('…') / axios('…')
  /\b(?:fetch|axios)\s*\(\s*[`'"]([^`'"]+)[`'"]/g,
  // client.get('…') / api.post(`…`) / http.put("…") / .delete('…') / .patch / .request
  /\.\s*(?:get|post|put|patch|delete|request)\s*\(\s*[`'"]([^`'"]+)[`'"]/g,
  TEMPLATE_URL_RE,
]

export const extractApiCallsFromText = (text, set = new Set()) => {
  for (const re of API_CALL_RES) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) {
      const p = apiPathFrom(m[1])
      if (p) set.add(p)
    }
  }
  return set
}

// Repo-level extraction of the `${…Api/Url/Base/Host…}/path` template literals used by clients that
// call their endpoints hook with NO literal argument and centralize the paths in the hook definition
// (e.g. skytrack-client's useBackendEndpoints.tsx — `${apiUrl}/loggers/search`). These carry no quoted
// hook arg for HOOK_RES to capture and no literal host for the URL fallback, so they were dropped.
// Reuses apiPathFrom so results normalize to the same shape as the `use…Endpoints('path')` style.
export const extractTemplateEndpointsFromText = (text, set = new Set()) => {
  TEMPLATE_URL_RE.lastIndex = 0
  let m
  while ((m = TEMPLATE_URL_RE.exec(text))) {
    const p = apiPathFrom(m[1])
    if (p) set.add(p)
  }
  return set
}

// Fallback: collect grepped backend URLs (env-normalized) into `set`. `text` is newline-separated
// URL matches (one per line). Filters out doc/asset noise; normalizes env segments to .{env}.
export const extractUrlEndpointsFromText = (text, set = new Set()) => {
  for (let l of text.split('\n')) {
    l = l.trim()
    if (!l) continue
    if (/atlassian|sharepoint|stoplight|webhook\.office|\/wiki|\/terms|\.(svg|png|pdf|jpe?g|gif|ico)/.test(l)) continue
    // same env-token list as backend-scan.mjs / assemble.mjs / guard-data.mjs normHost
    set.add(l.replace(/\.(dev|test|pre|prod|demo|poc|nonprod|sandbox|e2e)(?=\.)/g, '.{env}').replace(/["')\\,;]+$/, ''))
  }
  return set
}
