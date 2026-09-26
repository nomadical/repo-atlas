// Login via Keycloak. If the realm brokers to an upstream identity provider (Entra, Google, your
// own OIDC), users sign in there; this app only registers a Keycloak client and gates on a realm
// session.
//
// Auth is active only when all three VITE_ vars are baked into the build, so `npm run dev` and any
// build without them run open, and the published site turns the gate on just by setting the
// VITE_AUTH_* repo variables. See viz/.env.example and infra/keycloak.md.
//
// This gates the UI, not the data: a static data.enc is still fetchable by URL, protected only by
// its passphrase. For real protection serve the data from server/server.mjs and point VITE_DATA_URL
// at it; the viz then sends the token from getToken().

const serverUrl = import.meta.env.VITE_AUTH_SERVER_URL
const realm = import.meta.env.VITE_REALM
const clientId = import.meta.env.VITE_RESOURCE
// Realm or client role that grants admin powers (curating the model, dev mode, regenerate/publish).
const adminRole = import.meta.env.VITE_ADMIN_ROLE || 'admin'
const TOKEN_MIN_VALIDITY_SECONDS = 60

let keycloak = null

export const authEnabled = () => Boolean(serverUrl && realm && clientId)

// Without auth everyone is an admin, so local development keeps full access. With auth, non-admins
// get the read-only overview.
export const isAdmin = () => {
  if (!authEnabled()) return true
  const token = keycloak?.tokenParsed
  if (!token) return false
  const roles = [...(token.realm_access?.roles || []), ...(token.resource_access?.[clientId]?.roles || [])]
  return roles.includes(adminRole)
}

// Bearer token for authenticated fetches; null when auth is off or not ready yet.
export const getToken = () => keycloak?.token ?? null

// The signed-in user, or null when auth is off or not ready yet.
export const getUser = () => {
  const token = keycloak?.tokenParsed
  if (!token) return null
  return {
    name: token.name || token.preferred_username || token.email || 'Account',
    username: token.preferred_username,
    email: token.email,
  }
}

// Ends the realm session and returns to the app; the Keycloak client must allow this redirect.
export const logout = () => keycloak?.logout({ redirectUri: location.origin + location.pathname })

// Re-authenticate, e.g. after the data endpoint answers 401 because the session expired.
export const relogin = () => keycloak?.login()

// Resolves once the user has a realm session, or immediately when auth is off. An unauthenticated
// user is redirected to the login flow, so in that tab this never resolves; the app re-mounts after
// the redirect back.
export async function initAuth() {
  if (!authEnabled()) return { enabled: false }
  // loaded lazily so the library only ships when the gate is on
  const { default: Keycloak } = await import('keycloak-js')
  keycloak = new Keycloak({ url: serverUrl, realm, clientId })
  await keycloak.init({
    onLoad: 'login-required',
    // public SPA client: code flow with PKCE, no secret
    pkceMethod: 'S256',
    checkLoginIframe: false,
  })
  keycloak.onTokenExpired = () => keycloak.updateToken(TOKEN_MIN_VALIDITY_SECONDS).catch(() => keycloak.login())
  return { enabled: true, keycloak }
}
