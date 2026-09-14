# Login gate (Keycloak)

The map can gate access behind a **Keycloak** client. If your realm brokers to an upstream identity
provider — Microsoft Entra, Google, an OIDC provider of your own — users sign in there and this app
never talks to the provider directly; it only needs a realm session.

Integration lives in [`viz/src/auth.js`](../viz/src/auth.js) (`keycloak-js`, `onLoad:
'login-required'`, PKCE). It is **off until configured**: the gate activates only when all three
`VITE_AUTH_*` build vars are set, so local dev and an unconfigured deployment run open.

## 1. Register the client

Create a client on your realm:

| Setting | Value |
| --- | --- |
| Client ID | `repo-atlas` |
| Client type | OpenID Connect |
| Client authentication | **Off** (public — browser SPA, no secret) |
| Standard flow | **Enabled** (Authorization Code + PKCE `S256`) |
| Direct access grants | Disabled |
| Valid redirect URIs | every host the app answers on, e.g. `https://<org>.github.io/repo-atlas/*`, `https://architecture.example.com/*`, and `http://localhost:5173/*` for local dev |
| Valid post-logout redirect URIs | same as redirect URIs |
| Web origins | the origins of those same hosts (or `+`) |

Miss a host in the redirect URIs and login there fails with `invalid_redirect_uri` — this is the
single most common setup mistake, especially after adding a custom domain.

### Admin role

The privileged controls (⚙ Settings, **Dev mode**, **Regenerate/Publish**) are gated on a role;
everyone else gets the read-only overview. Add a **client role** named `admin` on the `repo-atlas`
client and assign it to whoever curates the map. A realm role of the same name also works —
[`isAdmin()`](../viz/src/auth.js) checks both. Override the name with the `VITE_ADMIN_ROLE` build
var. When auth is off (vars unset, as in local dev) everyone is treated as admin, so `npm run dev`
keeps full access.

## 2. Activate

Set these as GitHub Actions **repo variables** (Settings → Secrets and variables → Actions →
*Variables*) — not secrets; they aren't sensitive and they're compiled into a public bundle anyway:

```
VITE_AUTH_SERVER_URL = https://id.example.com/
VITE_REALM           = my-realm
VITE_RESOURCE        = repo-atlas
```

The next Pages deploy bakes them in and the gate goes live. To run the gate locally, copy
`viz/.env.example` to `viz/.env.local` instead.

## 3. Decide what the login actually protects

By default the login gates the **UI, not the data**: on a Pages deploy the static `data.enc` is
still fetchable by URL and protected only by its AES passphrase, so a user signs in **and** types
the passphrase. That's two weak gates rather than one strong one.

### Drop the passphrase (token-gated data)

Run the container ([`hosting.md`](hosting.md)) and point the `VITE_DATA_URL` repo variable at its
data route (`https://<your-host>/repo-atlas/data`). The viz then fetches the data with the Keycloak
bearer token, the server verifies the token and returns the data unencrypted over the wire, and the
passphrase gate disappears. It falls back to `data.enc` if the endpoint is unreachable.

If the viz is hosted on a **different origin** from the server (a Pages site fetching from your own
host), add that origin to the server's `CORS_ORIGINS` and redeploy the image before flipping the
variable. Verify with a preflight:

```bash
curl -i -X OPTIONS https://<your-host>/repo-atlas/data \
  -H 'Origin: https://<org>.github.io' \
  -H 'Access-Control-Request-Headers: authorization'
# expect an access-control-allow-origin header back
```

### Require a role (role-gated data)

By default **any valid realm token can read `/data`** — the server logs a startup warning saying so.
That's fine for an estate-wide internal map and wrong for anything narrower.

Set `AUTH_READ_ROLE` to a role name (say `ATLAS_READ`) and only users carrying it can read the data.
Create the role on the realm or any client and map it to whichever group should have access by
default. The server answers `403 {"error": "missing required role ATLAS_READ"}` for tokens without
it (realm roles **or** any client's resource roles are accepted), and the viz shows an
"ask for access" screen rather than the passphrase gate.

Set `AUTH_AUDIENCE=<client-id>` to additionally require the token's `aud` to include this app,
closing the confused-deputy case where a token minted for a *different* client on your realm is
replayed against the data route.

Both knobs are unset by default and independent of each other; each is a deliberate, reversible
environment change.

### Error semantics

A Keycloak/JWKS outage answers `503` (retry), not `401` — so a brief IdP blip doesn't sign everyone
out or drop the viz to its static fallback.
