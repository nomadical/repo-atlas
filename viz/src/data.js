import { getToken } from './auth.js'

// Data sources, in order: token-gated backend -> dev server API -> plaintext bundle ->
// encrypted bundle. VITE_DATA_URL is set for the fe-node-services deploy (Keycloak-gated route);
// the public Pages deploy ships data.enc only (see scripts/encrypt-data.mjs).
/** @returns {Promise<{ data?: import('./types').ArchData, encrypted?: object }>} */
export async function getData() {
  const dataUrl = import.meta.env.VITE_DATA_URL
  if (dataUrl) {
    try {
      const token = getToken()
      const r = await fetch(dataUrl, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
      if (r.ok) return { data: await r.json() }
      // 401 means the session lapsed -> let the app re-authenticate (don't fall back to the bundle).
      if (r.status === 401) {
        const e = new Error('unauthorized')
        e.unauthorized = true
        throw e
      }
      // 403 = authenticated but missing the read role (server AUTH_READ_ROLE, e.g. SAM_READ) ->
      // show the "ask for access" screen instead of degrading to the passphrase gate.
      if (r.status === 403) {
        const body = await r.json().catch(() => ({}))
        const e = new Error(body.error || 'access denied')
        e.forbidden = true
        throw e
      }
      // Any other status -> fall through to the static bundle (degrades to the passphrase gate).
    } catch (e) {
      if (e?.unauthorized || e?.forbidden) throw e
      // Network / CORS error -> also fall through to the static bundle rather than hard-failing.
    }
  }
  try {
    const r = await fetch('/api/data')
    if (r.ok) return { data: await r.json() }
  } catch {}
  try {
    const r = await fetch('./data.json') // published static fallback
    if (r.ok) return { data: await r.json() }
  } catch {}
  const r = await fetch('./data.enc')
  if (r.ok) return { encrypted: await r.json() }
  throw new Error('no data.json / data.enc found')
}

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
export async function decryptData(enc, passphrase) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64(enc.salt), iterations: enc.iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.iv) }, key, b64(enc.ct))
  return JSON.parse(new TextDecoder().decode(pt))
}
