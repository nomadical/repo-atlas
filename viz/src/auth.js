// Login via Keycloak. Point it at any realm; if that realm brokers to an upstream identity provider
// (Microsoft Entra, Google, an OIDC provider of your own) users sign in there and this app never
// talks to the provider directly — it only registers a Keycloak client and gates on a realm session.
//
// Auth is active ONLY when all three VITE_ vars are baked into the build. That keeps `npm run dev`
// and any build without them running open, and lets the published site flip the gate on simply by
// setting the repo's VITE_AUTH_* variables (after the Keycloak client below is registered) — no
// code change. See viz/.env.example and infra/keycloak.md.
//
// NOTE: this gates the UI, not the data. A static data.enc is still fetchable by URL and protected
// only by its AES passphrase. For real data protection serve the data from server/server.mjs and
// point VITE_DATA_URL at it — the viz then fetches with the token from getToken().

const url = import.meta.env.VITE_AUTH_SERVER_URL
const realm = import.meta.env.VITE_REALM
const clientId = import.meta.env.VITE_RESOURCE
// Role that grants admin powers (curate the model, dev mode, regenerate/publish). Realm OR client
// role — assign it on the Keycloak client/realm. Override the name with VITE_ADMIN_ROLE.
const adminRole = import.meta.env.VITE_ADMIN_ROLE || 'admin'

let keycloak = null

export const authEnabled = () => Boolean(url && realm && clientId)

// Admin = may use the privileged controls. When auth is DISABLED (npm run dev, or any build without
// the VITE_AUTH_* vars) everyone is an admin, so local development keeps full access. When auth is
// enabled, gate on the realm/client role above — non-admins get the read-only overview.
export const isAdmin = () => {
  if (!authEnabled()) return true
  const t = keycloak?.tokenParsed
  if (!t) return false
  const roles = [...(t.realm_access?.roles || []), ...(t.resource_access?.[clientId]?.roles || [])]
  return roles.includes(adminRole)
}

// Bearer token for future authenticated fetches (e.g. data from fe-node-services). Null when
// auth is disabled or not yet ready.
export const getToken = () => keycloak?.token ?? null

// Signed-in user (from the realm token), or null when auth is off / not yet ready.
export const getUser = () => {
  const t = keycloak?.tokenParsed
  if (!t) return null
  return { name: t.name || t.preferred_username || t.email || 'Account', username: t.preferred_username, email: t.email }
}

// End the realm session and return to the app (the post-logout redirect must be allowed on the
// Keycloak client). No-op when auth is disabled.
export const logout = () => keycloak?.logout({ redirectUri: location.origin + location.pathname })

// Re-authenticate (e.g. after the data endpoint 401s because the session expired). Redirects to
// Keycloak and back. No-op when auth is disabled.
export const relogin = () => keycloak?.login()

// Resolves once the user has a realm session (or immediately when auth is disabled). When the user
// is unauthenticated, Keycloak redirects the whole page to the login flow, so this never resolves
// in that tab — the app re-mounts after the redirect back.
export async function initAuth() {
  if (!authEnabled()) return { enabled: false }
  const { default: Keycloak } = await import('keycloak-js') // lazy: only ship the lib when gated
  keycloak = new Keycloak({ url, realm, clientId })
  await keycloak.init({
    onLoad: 'login-required',
    pkceMethod: 'S256', // public SPA client — code flow + PKCE, no secret
    checkLoginIframe: false,
  })
  // keep the token fresh so getToken() is usable for API calls later
  keycloak.onTokenExpired = () => keycloak.updateToken(60).catch(() => keycloak.login())
  return { enabled: true, keycloak }
}
