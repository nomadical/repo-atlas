# repo-atlas

**An architecture map your organisation can't forget to update.** Point it at a GitHub org and a
Node pipeline reads each repo's own metadata — tooling versions, internal and external dependencies,
endpoints, deploy targets, test footprint, ownership — into JSON, which a React Flow app renders as
a clustered, filterable diagram.

There is **no central spreadsheet**. A repo appears on the map, correctly, because its owner
curated it on GitHub: a description, a few topics, a couple of custom properties. Nothing to keep
in sync by hand, and the map can't quietly rot into fiction.

This repo ships with a **synthetic demo estate** (the fictional *Meridian Labs*), so
`npm run dev` shows a working map before you've configured anything.

## What it gives you

- **A graph** of components, clustered by team, with dependency, service-link and deploy edges.
- **A Component Inventory** — the same data as a sortable table, a per-application matrix, and an
  integrations list.
- **Drill-down into a client**: its screens (routes) and the backend endpoints each one calls.
- **Golden Path compliance**: every repo scored against your engineering standards, tracked over
  time, with a curated log of accepted deviations.
- **Health**: stale repos, dependency-version drift, open security alerts, failing CI.
- **Shareable URLs and embeddable slices** — the whole view lives in the URL, so any filtered slice
  can be framed in a wiki page.

## Quick start

```bash
npm --prefix viz ci
npm run dev        # the demo estate, at http://localhost:5173
```

Then point it at your own org:

1. **Fork** this repo and enable Pages (*Settings → Pages → Source: GitHub Actions*).
2. **Give the pipeline read access**: a fine-grained PAT (or GitHub App token) with
   **Contents: read** + **Metadata: read** on the repos you want mapped, saved as the `REPOS_TOKEN`
   repo secret. That's the only access it ever needs.
3. **Set the `GITHUB_ORG` repo variable** to your org (*Settings → Secrets and variables → Actions
   → Variables*). Optional: `EXTRA_CLONE_URLS` for repos outside the org, `BACKEND_REPOS` for extra
   backends beyond the auto-discovered ones.
4. **Curate your repos** with `type-*` / `status-*` / `owner-*` / `app-*` topics — see
   [`docs/repo-maintenance.md`](docs/repo-maintenance.md) for the owner's checklist and
   [`docs/topic-schema.md`](docs/topic-schema.md) for the field reference. A repo joins the map as
   soon as it has a `type-*` topic.
5. **Make it yours**: copy [`config.template.json`](config.template.json) over `config.json` and set
   the title, your `clusters` taxonomy, `internalScopes`, and `uiPackages`. Most of it is also
   editable in-app via ⚙ Settings.
6. Run the **`regenerate`** workflow (or `npm run regenerate` against local clones); `pages.yml`
   publishes the result.

> **Replacing the demo data.** `npm run regenerate` overwrites the committed `fe-architecture*.json`
> and `github-meta.json` with your own estate. The demo's curated overlays — `backend-extra.json`,
> `repo-extra.json`, `inventory-extra.json`, `integrations.csv`, `third-party-meta.csv`,
> `golden-path/` — are yours to edit; each file documents its own shape in a `_comment` field.

## Configuration

Everything org-specific lives in `config.json`, fully documented in
[`config.template.json`](config.template.json). Nothing is required — each field falls back to a
sensible default, and an unset field means "this doesn't apply to my estate" rather than "broken".

The ones worth setting first:

| Field | What it does |
| --- | --- |
| `clusters` | Your team taxonomy. Drives the graph's lanes, the Group filter, and the region colors. Unset, everything lands in one centre lane. |
| `internalScopes` | The npm scopes your org publishes under — what counts as an internal-dependency edge. |
| `uiPackages` / `uiHubFolders` | Your design system. Consumers collapse onto one hub card, and version drift against it is drawn. |
| `owners` / `applications` | Your team and application vocabulary. Both are **open** — an undeclared topic is accepted and auto-titled, so declare one only when the automatic title is wrong. |
| `guard` | Coverage tripwires for the nightly run. Set them once your map looks right. |
| `apiDomains` | Your own API domains, so a CDN link isn't mistaken for an endpoint. |

## Layout

| Path | What it is |
| --- | --- |
| `scripts/` | The data pipeline (gather → parse → assemble) that produces the JSON below |
| `scripts/repos.mjs` | Repo discovery — auto-discovered from local clones; org membership read from each clone's own `remote.origin.url`; Java backends (no `package.json`) discovered separately for `backend-scan.mjs` |
| `scripts/_paths.mjs` | Portable paths (override the checkout dir with `ATLAS_REPOS_DIR`) |
| `github-meta.json` | Component Inventory built **live from GitHub** — descriptions + `type-`/`status-`/`owner-`/`app-` topics. Written by `scripts/github-inventory.mjs` |
| `inventory-extra.json` | What can't live on a repo: dates, comments, display-name overrides, and components with **no repo** (third-party services) |
| `repo-extra.json` | Curated per-repo knowledge: hosts/APIs, non-npm SaaS, FE→BE notes, cloud name maps |
| `backend-extra.json` | Curated backend topology: hosts, FE→BE wiring, service edges, deploy targets |
| `integrations.csv` | Curated service-to-service REST/Kafka links. Both protocols are **also derived from code**, and a curated row for the same pair flips to *verified* |
| `third-party-meta.csv` | Vendor, auth, criticality and hosts for third-party services |
| `fe-architecture.json` | Core model: repos, kinds, deps, endpoints, deployments, `validation`, `inventory` |
| `fe-architecture-extras.json` | Enrichment: purposes, ownership, test footprint, screens |
| `config.json` | Your configuration — see above |
| `viz/` | The React Flow + Vite app |
| `viz/src/graph.js` | Graph and cluster layout |
| `golden-path/` | Compliance scoring: the rules, the nightly history, and the decision log |
| `server/server.mjs` | Token-gated `/data` API + static viz server (built by the `Dockerfile`) |
| `infra/` | [`keycloak.md`](infra/keycloak.md) (login) + [`hosting.md`](infra/hosting.md) (self-hosting) |
| `.github/workflows/` | `ci.yml`, `pages.yml` (build + deploy), `regenerate.yml` (nightly), `curation-report.yml` (weekly backlog) |

## Commands

```bash
npm run dev        # viz dev server (proxies the live model + Regenerate/Publish)
npm run regenerate # re-run the whole pipeline against your local clones
npm run build      # build the viz and bake data into published/
npm run guard      # sanity-check the generated data (CI runs this before committing)
npm test           # pipeline + graph + schema tests
```

Repos are **auto-discovered**: any sibling checkout under the parent directory that's a git repo
with a `package.json` is picked up. Java backends have none, so they're discovered separately and
modelled from their build files. Set `ATLAS_REPOS_DIR` to point elsewhere and `ATLAS_FETCH=1` to
`git fetch` each repo before reading. The pipeline reads **local clones**, so the data is only as
fresh as your checkouts — which is what the nightly workflow is for.

## Hosting

- **GitHub Pages** (`pages.yml`) — builds and deploys on every change to `main`. Self-contained;
  no external services. Pages is public, so the data is protected by an AES passphrase
  (`scripts/encrypt-data.mjs`) unless you wire up login.
- **Your own container** (`Dockerfile` + `server/server.mjs`) — serves the viz plus a
  **token-validated `/data`** route, which is real data protection rather than a passphrase. See
  [`infra/hosting.md`](infra/hosting.md).
- **Login** is off by default. Set the `VITE_AUTH_*` variables to gate access behind Keycloak — see
  [`infra/keycloak.md`](infra/keycloak.md). **Admins** (the `admin` role) additionally get ⚙
  Settings, Dev mode, and Regenerate/Publish. Locally (`npm run dev`) auth is off and you have full
  admin access.

## Reading the diagram

Switch between **Graph**, **Matrix**, **Table** and **Integrations** (top-left). **Table** is the
full sortable Component Inventory; **Matrix** pivots components by application; **Integrations**
lists the service links.

**Group by** (Graph view) switches which taxonomy the lanes follow — **Team** (your clusters),
**Application** (one lane per `app-*`), or **Platform** (applications rolled up via
`config.platforms`). Grouping is layout-only: the Group *filter* stays the team taxonomy, so the two
compose.

Two toolbar dropdowns separate *adding* detail from *narrowing*:

- **Layers** (additive) — **Resources**, **Integrations** (external SaaS), **Deployments**,
  **Inventory catalog**, and **Service links** (REST solid, Kafka dashed via a shared event-bus
  node).
- **Filters** (subtractive — OR within a dimension, AND across them) over **Group**, **Status**
  (Current / Planned / Sunsetting / Removed) and **Health** (*At-risk only*). Non-matching cards are
  hidden while the shared infrastructure they connect to survives; an empty dimension imposes no
  constraint. **Reset filters** returns to the clusters' `defaultOn` set.

**Dev mode** (admin-only) adds tooling, test and deploy detail. Hover a card to spotlight its
relations; click a cluster to focus its members; click a card for full detail. Use **search** to
highlight repos, the **⚠ health** pill for pipeline warnings, and **⎙ Export** to save a PNG.

**Drilling into a client.** Double-click a frontend card (or click *View N screens →*) to open its
screens (routes) and the backend endpoints each one calls, with clickable Swagger links. Shareable
via `?client=<repo-folder>`. Screen data is extracted heuristically by `scripts/screens-gather.mjs`
(router parsing + import-graph tracing), so coverage is best-effort.

**Embedding a slice.** Set the filters to isolate what you want, then click **`</>` Embed** to get
an `<iframe>` snippet. It appends `embed=1`, which loads a chrome-less kiosk view — just the map
plus an *"Open full map"* link.

Cards flag **stale** repos (no commit in > `staleDays`), and design-system dependency edges turn red
when a consumer lags the latest referenced version. Clicking a node shows its Component Inventory
record; non-current components are styled (sunsetting dashed amber, planned dotted, removed
struck-through).

## License

[MIT](LICENSE).
