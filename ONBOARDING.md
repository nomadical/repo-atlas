# repo-atlas — Contributor & Operator Guide

How the thing is put together, how to run it, and how to operate it once it's live. For *what it
does* and how to point it at your org, start with [`README.md`](README.md).

## The shape of it

Two halves, joined by committed JSON:

```
local clones ──┐
GitHub API ────┼──► scripts/*.mjs ──► fe-architecture.json ──► viz/ (React Flow) ──► the map
curated JSON ──┘     (the pipeline)    fe-architecture-extras.json
```

The pipeline never talks to the viz directly. It writes files, the guard checks them, and they get
committed — so the map is always reproducible from what's in git, and a broken pipeline run leaves
yesterday's good data in place instead of publishing a hole.

**Three sources feed it**, in descending order of trust:

1. **The repos themselves** — cloned locally, read for tooling versions, dependencies, endpoints,
   workflows, test files. Facts, not opinions.
2. **GitHub metadata** — descriptions, topics, custom properties. Curated by each repo's owner,
   read fresh every night. This is what makes the map self-maintaining.
3. **Curated overlays** (`backend-extra.json`, `repo-extra.json`, `inventory-extra.json`,
   `integrations.csv`) — only for what genuinely can't be derived: repo-less third-party services,
   backend topology, hosts. Kept deliberately small; every entry here is something that can rot.

## Run it locally

```bash
npm --prefix viz ci
npm run dev        # viz dev server — serves the live local model + Regenerate/Publish APIs
npm run regenerate # re-run the whole pipeline against your local clones
npm run build      # build the viz and bake data into published/
npm run guard      # sanity-check generated data (CI runs this before committing)
npm test           # pipeline + graph + schema tests
```

Repos are **auto-discovered**: any sibling checkout under the parent directory that's a git repo
with a `package.json` is picked up. Set `ATLAS_REPOS_DIR` to point elsewhere, `ATLAS_FETCH=1` to
`git fetch` first. The pipeline reads **local clones**, so data is only as fresh as your checkouts.

In local dev **auth is off and you are treated as admin** — full access to Settings, Dev mode,
Regenerate and Publish — so nothing is gated while you work.

### Pipeline steps

`npm run regenerate` runs these in order; each writes a file the next one reads, so the order
matters. Most accept an env switch to skip or force them (`ATLAS_GH=0`, `ATLAS_AZURE=force`, …),
which is how you iterate on a late step without re-running the slow early ones.

| Step | Reads | Writes |
| --- | --- | --- |
| `gather-arch` | local clones | per-repo scan (tooling, deps, endpoints) |
| `parse-workflows` | `.github/workflows` in each clone | deploy targets |
| `module-graph` | each clone's `src/` | intra-repo module edges |
| `azure-gather` | Azure CLI (optional) | `azure-resources.json` |
| `github-inventory` | GitHub API | `github-meta.json` |
| `sync-names` | GitHub API | `name-drift.json` (follows renames) |
| `backend-scan` | Java build files | `backend-tooling.json` |
| `assemble` | all of the above + curated overlays | **`fe-architecture.json`** |
| `extras-gather` → `extras-assemble` | clones + the core model | **`fe-architecture-extras.json`** |
| `screens-gather` | client routers | per-screen endpoint data |

The nightly workflow tolerates individual step failures ("degraded") but the **guard** then requires
the core model to actually be from tonight — otherwise a failed `assemble` would pair yesterday's
model with today's siblings and commit a mixed-generation dataset.

## Admin panel & config (⚙ Settings)

The ⚙ panel curates what can't be auto-derived. The source of truth is git-committed; in dev it
writes the files via `/api/save-curation`, then you Regenerate. Tabs:

- **Settings** — app config written to `config.json` (merged into the served data as `data.config`):
  title, subtitle, logo, default view/mode/theme, staleness thresholds. Empty fields fall back to
  built-in defaults; defaults seed first-load state only, so a shared `?`-link or an in-session
  change wins.
- **Backends / FE→BE wiring / Integrations / Inventory gaps** — backend topology, client→backend
  wiring, `integrations.csv` edges, and inventory fallbacks.

`config.json` also drives taxonomy and branding — `clusters`, `clusterColors`, `productTags`,
`tagColors`, `docSearchUrl`, `regionNotes`. Every field is documented inline in
[`config.template.json`](config.template.json).

## Access & auth

Off by default; the site is open. It activates only when three **repo Actions variables** are set,
so local dev and un-configured builds stay open:

| Variable | Example |
| --- | --- |
| `VITE_AUTH_SERVER_URL` | `https://id.example.com/` |
| `VITE_REALM` | `my-realm` |
| `VITE_RESOURCE` | `repo-atlas` |

Toggle the gate by setting or deleting those (`gh variable set/delete`) and redeploying. Setup is in
[`infra/keycloak.md`](infra/keycloak.md); the code is `viz/src/auth.js`.

**Admin role.** ⚙ Settings, Dev mode, Regenerate and Publish are gated on an `admin` role (Keycloak
realm **or** client role; override the name with `VITE_ADMIN_ROLE`). Non-admins get the read-only
overview. When auth is off, everyone is admin.

**Data.** Setting `VITE_DATA_URL` to your server's data route makes the viz fetch with the Keycloak
bearer token — login, then the map, no passphrase. If that endpoint is unreachable, `viz/src/data.js`
**falls back** to the AES-encrypted `data.enc` bundle behind a shared passphrase. If the viz is on a
different origin from the server, add it to the server's `CORS_ORIGINS`.

### Verifying auth changes

Auth failures are quiet and easy to misread, so check before flipping the gate rather than
deploy-and-break:

- **A redirect that reaches Keycloak is not proof of success** — it can render an error body
  ("Invalid parameter: redirect_uri", "Client not found"). Look at the actual page.
- Probe the authorize endpoint directly:
  ```bash
  curl 'https://id.example.com/realms/my-realm/protocol/openid-connect/auth?client_id=repo-atlas&redirect_uri=<your-url>&response_type=code&scope=openid'
  ```
  and check the body for `Client not found` / `Invalid parameter` versus a real login form.
- Verify CORS before relying on the token-data path:
  ```bash
  curl -i -X OPTIONS https://<your-host>/repo-atlas/data \
    -H 'Origin: https://<viz-origin>' -H 'Access-Control-Request-Headers: authorization'
  ```
  Expect `204` and an `access-control-allow-origin` header.

## Deploys

- **`ci.yml`** — tests, lint, data guard and a build on every PR and push to `main`.
- **`pages.yml`** — builds the viz, bakes the data, encrypts it, deploys `published/` to GitHub
  Pages. Runs on push to `main` (viz/data changes) and on dispatch. The `VITE_*` repo variables are
  baked in here.
- **`regenerate.yml`** — the nightly pipeline refresh. Commits **only if the guard passes**, then
  dispatches `pages.yml` explicitly (a `GITHUB_TOKEN` push never fires push-triggered workflows).
- **`curation-report.yml`** — weekly; opens/updates a single tracking issue listing uncurated and
  half-curated repos, grouped by owning team.
- **Your own container** — `Dockerfile` + `server/server.mjs`, see [`infra/hosting.md`](infra/hosting.md).
  The image bakes in the data, so a data refresh means rebuilding the image; a plain restart won't
  pick up source or data changes.

## Key files

| Path | What |
| --- | --- |
| `scripts/assemble.mjs` | The heart of the pipeline — merges every source into the core model |
| `scripts/guard-data.mjs` | The safety net: coverage, edge integrity, topic-schema conformance |
| `scripts/inventory.mjs` | Topic parsing and the Component Inventory merge |
| `scripts/screens-gather.mjs` | Per-client screens + endpoints (router parse / dir scan) |
| `viz/src/App.jsx` | Toolbar, filters, admin gating, config-driven title/defaults |
| `viz/src/graph.js` | Graph + config-driven cluster layout/taxonomy + filter logic |
| `viz/src/clientGraph.js` | Per-client drill-down (screen → endpoint → backend) |
| `viz/src/AdminPanel.jsx` | ⚙ Settings + curation editor |
| `viz/src/data.js` | Data fetch: token endpoint → static bundle → encrypted fallback |
| `viz/vite.config.mjs` | Dev server APIs (`/api/data`, `/curation`, `/regenerate`, `/publish`) |
| `server/server.mjs` | Token-gated `/data` server (+ CORS) |
| `golden-path/` | Compliance scoring — rules, nightly history, decision log |
| `screens-extra.json` | Curated overrides for the heuristic screen data (drop/patch/add) |
| `config.template.json` | Documented template for every `config.json` field |

## Conventions

- **Derive, don't curate.** Before adding a field to a curated overlay, check whether it can be read
  from the repo instead. Every hand-maintained value is one that will eventually be wrong.
- **A missing thing is not a broken thing.** Unset config means "doesn't apply here", and the code
  should render accordingly rather than warning or failing. The tests hold for an estate with no
  clusters, no design system, and no golden-path rules.
- **The guard is the contract.** If a change could silently drop nodes or edges, add a check to
  `guard-data.mjs` rather than trusting review to catch it.
- **Tests run against the committed data**, so they assert invariants that hold at any size — never
  today's numbers. An exact repo count would turn a normal night into a red CI on someone else's PR.
