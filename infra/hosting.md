# Self-hosting the Keycloak-gated deployment

The GitHub Pages build ([`pages.yml`](../.github/workflows/pages.yml)) is the quickest way to get
the map online, but Pages is public: the data behind it is only protected by an AES passphrase
(`scripts/encrypt-data.mjs`). Running the container instead gives you a real gate — the data is
served **only** to callers holding a valid token.

Use this when the map describes an estate you don't want readable by anyone with the link.

## What runs

| Piece | What it does |
| --- | --- |
| [`Dockerfile`](../Dockerfile) | Two-stage build: compiles the viz with the Keycloak gate and the authed data URL baked in, then packages it with the `server/` runtime |
| [`server/server.mjs`](../server/server.mjs) | Serves the viz under `BASE_PATH` plus a `BASE_PATH/data` route that requires a valid realm bearer token (JWKS-verified) |

The image bakes in the data files, so a data refresh means rebuilding the image. That's deliberate:
the server holds no state and can be replaced at any time.

## Build and run

```bash
docker build -t repo-atlas \
  --build-arg VITE_AUTH_SERVER_URL=https://id.example.com/ \
  --build-arg VITE_REALM=my-realm \
  --build-arg VITE_RESOURCE=repo-atlas .

docker run -p 8080:8080 \
  -e AUTH_ISSUER=https://id.example.com/realms/my-realm \
  repo-atlas
```

The `VITE_*` build args must match the Keycloak client you register in
[`keycloak.md`](keycloak.md) — they're compiled into the bundle, so changing them means rebuilding.
`AUTH_ISSUER` is read at runtime and the server refuses to start without it: a wrong issuer would
silently fail every token instead.

### Environment

| Variable | Default | What it's for |
| --- | --- | --- |
| `AUTH_ISSUER` | *(required)* | Keycloak realm issuer URL. The server validates every `/data` token against its JWKS. |
| `PORT` | `8080` | Listen port. |
| `BASE_PATH` | `/repo-atlas` | Path prefix the app is served under. Set to match your ingress route. |
| `CORS_ORIGINS` | *(same-origin only)* | Comma-separated origins allowed to fetch `/data` cross-origin. Needed only if a **separately hosted** copy of the viz (your Pages site, say) fetches from this server. |
| `GP_DECISION_LOG` | *(in-image)* | Path to durable storage for the Golden Path decision log. Without it, decisions written through the UI die with the container. |

## Behind an ingress

Route your ingress at the container's port with the path prefix you set as `BASE_PATH`. Two things
are worth knowing:

- **Serving at the domain root.** If you want the map at `https://architecture.example.com/` rather
  than under a path, have your proxy add the `BASE_PATH` prefix to root requests. The viz's asset
  URLs are relative, so this is transparent. Add a second, higher-priority rule that passes
  already-prefixed requests through untouched — otherwise the baked-in `VITE_DATA_URL` and any deep
  link get the prefix applied twice.
- **Keycloak redirect URIs** must list every host the app answers on, or login fails there with
  `invalid_redirect_uri`. See [`keycloak.md`](keycloak.md).

The data route is same-origin on these hosts, so no `CORS_ORIGINS` entry is needed for them.

## Data protection

Unauthenticated requests to `/data` get a `401`. `server.mjs` validates the JWT against the realm
JWKS (`AUTH_ISSUER/protocol/openid-connect/certs`), checking signature, issuer and expiry.

**Audience is deliberately not checked**, so any authenticated user on the realm may read the map.
That suits an estate-wide internal map. If yours is more sensitive, add an audience or role check in
`requireAuth` — the `admin` role check in `isAdmin` shows the shape.
