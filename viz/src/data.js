import { getToken } from './auth.js'

// Data sources, in order: the token-gated backend (VITE_DATA_URL, set for the Keycloak-gated
// deploy), the dev server API, the plaintext bundle, the encrypted bundle. The public Pages deploy
// ships data.enc only (see scripts/encrypt-data.mjs).
/** @returns {Promise<{ data?: import('./types').ArchData, encrypted?: object }>} */
export async function getData() {
  const gated = await fetchGatedData(import.meta.env.VITE_DATA_URL)
  if (gated) return gated
  const fromApi = await tryFetchData('/api/data')
  if (fromApi) return fromApi
  const published = await tryFetchData('./data.json')
  if (published) return published
  const response = await fetch('./data.enc')
  if (response.ok) return { encrypted: await response.json() }
  throw new Error('no data.json / data.enc found')
}

function flaggedError(message, flag) {
  const error = new Error(message)
  error[flag] = true
  return error
}

// 401 and 403 are thrown so the app can re-authenticate or show the "ask for access" screen. Any
// other failure (other status, network, CORS) returns null and falls through to the static bundle.
async function fetchGatedData(dataUrl) {
  if (!dataUrl) return null
  try {
    const token = getToken()
    const response = await fetch(dataUrl, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
    if (response.ok) return { data: await response.json() }
    // the session lapsed: re-authenticate rather than fall back to the bundle
    if (response.status === 401) throw flaggedError('unauthorized', 'unauthorized')
    // signed in but missing the read role (server AUTH_READ_ROLE)
    if (response.status === 403) {
      const body = await response.json().catch(() => ({}))
      throw flaggedError(body.error || 'access denied', 'forbidden')
    }
  } catch (error) {
    if (error?.unauthorized || error?.forbidden) throw error
  }
  return null
}

async function tryFetchData(url) {
  try {
    const response = await fetch(url)
    if (response.ok) return { data: await response.json() }
  } catch {
    // unreachable or not JSON: try the next source
  }
  return null
}

const base64ToBytes = (base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))

export async function decryptData(enc, passphrase) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: base64ToBytes(enc.salt), iterations: enc.iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(enc.iv) }, key, base64ToBytes(enc.ct))
  return JSON.parse(new TextDecoder().decode(plaintext))
}
