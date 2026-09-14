# Component Inventory — Topic Schema

The architecture map's **Component Inventory is built live from GitHub**, not from a file in
this repo. A component's classification lives on its own repository as GitHub **topics** and
**org custom properties**; the pipeline (`scripts/github-inventory.mjs` → `scripts/inventory.mjs`)
reads them on every regenerate, so curating a repo on GitHub immediately updates the map.

This page is the single source of truth for that schema. It should stay in sync with `TOPIC_MAPS`
in [`scripts/inventory.mjs`](../scripts/inventory.mjs) (the code that parses these topics) and with
the `owners` / `applications` vocabularies in [`config.json`](../config.template.json).

> For the practical "how do I curate my repo" checklist, see
> [`repo-maintenance.md`](repo-maintenance.md). This page is the field reference it points to.

> **To appear on the map, a repo needs:** a one-line GitHub **description** + at least one of
> the inventory topics below (a `type-*` topic is the minimum). Repos with none are treated as
> "not an inventory component" and skipped.

## How a repo maps to an inventory record

| Inventory field | Source | Notes |
| --- | --- | --- |
| Name | repo name (or override in `inventory-extra.json`) | |
| Description | repo description | one line, present-tense |
| Type | `type-*` topic | **closed** enum (below) |
| Status | `status-*` topic | **closed** enum (below) |
| Owner team | `owner-*` topic | **open** — new teams allowed |
| Application(s) | `app-*` topic(s) | **open** — one topic per app served |
| Abbreviation | org custom property `abbreviation` | |
| Technical contact | org custom property `technical-contact` | |
| Documentation link | org custom property `doc-url` | full URL to the page |
| Documentation label | org custom property `doc-label` | shown text; falls back to the URL |
| API / live / docs URLs | org custom properties `api-url` / `live-url` / `swagger-url` | override `repo-extra.json` hosts |
| Azure app key / ACR image | org custom properties `azure-app-key` / `acr-image` | override `repo-extra.json` azure maps |
| Dates, comments, review trail | `inventory-extra.json` | can't live on a repo |

`type`/`status` are **closed** enums — `scripts/guard-data.mjs` fails the nightly commit if a
component carries an unknown value (catches typos like `status-currnet`). `owner`/`app` are
**open** so new teams and applications can be added without a code change; the guard only warns
on an unrecognized owner.

## Topics

GitHub topic rules: lowercase, dashes only. A team name containing dots maps dots → dashes
(`Platform.Core` → `owner-platform-core`).

### `type-*` (closed)

| Topic | Inventory value |
| --- | --- |
| `type-client` | Client (FE app) |
| `type-service` | Service (backend / internal) — a non-JS/TS `type-service` repo is auto-cloned nightly and scanned for its tooling (Java `build.gradle`/`pom.xml`); no central list |
| `type-third-party-service` | Third-Party Service |
| `type-library` | Library |
| `type-assets` | Assets |
| `type-tests` | Tests |
| `type-firmware` | Firmware (device / IoT firmware) |
| `type-infra` | Infrastructure (IaC: Terraform, Helm, ArgoCD, deployment configs) |
| `type-hardware` | Hardware (PCB / board designs) |
| `type-data` | Data (pipelines, reporting, data platform) |
| `type-config` | Config (config-as-code: Keycloak, schema registry, etc.) |

### `subtype-*` (closed, optional)

An optional refinement of `type-*` — each subtype is valid only on its parent type (the guard
fails a mismatched pair, e.g. `subtype-worker` on a Library). Unset = the plain type.

| Topic | Parent type | Meaning |
| --- | --- | --- |
| `subtype-api` | Service | request/response backend (the default reading of a plain Service) |
| `subtype-worker` | Service | background/batch processing, no request surface |
| `subtype-connector` | Service | bridge to an external system (publishers, ingestors, CDC) |
| `subtype-gateway` | Service | edge/routing layer (API gateway, redirect proxy) |
| `subtype-framework` | Library | a foundation others build on (nucleus, @framework/ui) |
| `subtype-ui` | Library | UI component kit / theme |
| `subtype-model` | Library | shared model / SDK, no UI |

Repo-less components carry their subtype in `inventory-extra.json` (`subtype` field, same values).

### Derived fields (never curated)

`language` and `framework` are **measured**, not topics: build-file scan (Java + Quarkus from
`backend-tooling.json`) > FE `toolingVersions` (TypeScript/JavaScript + React) > GitHub
`primaryLanguage` as the fallback for everything else. Shown in the Details panel ("Stack") and
the Table's Stack column. Don't add `lang-*` topics — the pipeline already knows.

### `status-*` (closed)

| Topic | Inventory value | Map styling |
| --- | --- | --- |
| `status-current` | Current | normal |
| `status-planned` | Planned | dotted outline |
| `status-sunsetting` | Sunsetting | dashed amber |
| `status-removed` | Removed | struck-through |

### `owner-*` (open)

One topic naming the team that owns the component, e.g. `owner-platform`, `owner-storefront`.

The vocabulary is yours and lives in `config.json` `owners` (display name → slug). It's **open**:
an unlisted `owner-*` topic is accepted and auto-titled, so a new team works the moment someone
writes the topic. Declare it in `owners` when the automatic title is wrong, and route it to a
cluster via the `match` prefixes in `config.json` `clusters` — otherwise its components land in the
fallback cluster.

With no `owners` declared at all, every owner is accepted silently; the guard's "not in the
documented schema" warning only fires once you've declared a vocabulary to deviate from.

### `cluster-*` (optional override)

By default a component sits in its owning team's cluster on the map — its `owner-*` topic is routed
to a cluster by the `match` prefixes in `config.json` `clusters`. A `cluster-*` topic overrides
that, for cross-cutting components that serve the whole estate:

| Topic | Places the component in |
| --- | --- |
| `cluster-<label>` | the cluster with that label, regardless of owner |
| the fallback cluster's label | the centre column (e.g. `cluster-shared` when a cluster is labelled "Shared") |

Slugs resolve back to the labels you declared, so a label with irregular casing ("IoT") survives the
round-trip through a lowercase topic. An unrecognised slug is title-cased (`cluster-frontend` →
"Frontend"), so a new cluster works before it's configured.

This also works for a shared **package** that appears on the map only as a dependency node (say
`@acme/kb-react`): curate the `kb-react` repo with `type-library` + `owner-*` + `cluster-shared`,
and the package node moves out of the default package column into the shared cluster.

### `app-*` (open)

One topic per application the component serves, e.g. `app-shop`, `app-ops-console`.

The vocabulary is yours and lives in `config.json` `applications` (display name → slug). It's
**open**: an `app-*` topic that isn't listed is auto-titled (`app-fleet-ops` → "Fleet Ops"), so a
new application works immediately. Declare one only when the automatic title is wrong — an acronym,
punctuation, irregular casing — or when the display name has to match exactly what
`applicationLabels`, `productTags`, `platforms` and `inventory-extra.json` use, or one application
splits into two columns in the Matrix view.

`owner-*` works the same way, against `config.json` `owners`.

## Org custom properties

Set under **Org → Settings → Repository properties**:

| Property | Inventory field |
| --- | --- |
| `abbreviation` | Abbreviation (e.g. `ORD`) |
| `technical-contact` | Technical contact (display name) |
| `doc-url` | Documentation link (full URL to the page) |
| `doc-label` | Documentation label (shown text; the URL is used if empty) |
| `api-url` | Primary API origin (`{env}` template ok, e.g. `api.{env}.example.com`) — drives the FE→backend trace + Swagger deep-links |
| `live-url` | Where the app runs (a detected prod cloud domain still wins) |
| `swagger-url` | API docs URL (else derived from `api-url` as the Quarkus default) |
| `azure-app-key` | The `{env}<key>website` Azure static-site key(s) for this repo, comma/space-separated for several (e.g. `shop shopv2`) |
| `acr-image` | The container image name, if it differs from the component name |

These aren't topics because they're free-text and shouldn't pollute the topic namespace.
`doc-url` / `doc-label` are read straight through — set `doc-url` to the real page URL so the
map links to it directly; a bare `doc-label` with no `doc-url` routes to a wiki quick-search.
The host + Azure properties are **owner-owned overrides**: each falls back to the
[`repo-extra.json`](../repo-extra.json) curated map, so setting the property on your repo replaces
the central entry (a just-set value takes effect on the next nightly). Leave them unset and nothing
changes.
Property values cap at 75 characters. If your wiki has a short canonical URL form (many do — a page
id without the title slug, which still redirects), use it.

## `inventory-extra.json`

For everything that can't live on a repo:

- **`repoExtras`** — keyed by repo name; per-repo extras (e.g. `doc` link) and a `fallback`
  block of inventory fields for repos whose topics haven't been written yet. **Topics win over
  fallbacks**, so the fallback is only a stopgap — write the real topics and delete the fallback.
- **`nonRepo`** — components with no GitHub repo: third-party services, vendor platforms, hardware.
  Each is a full inventory record (`name`, `type`, `status`, `owner`, `applications`, `contact`,
  `description`, …) using the same closed/open value vocabulary as the topics above.

## Changing the schema

1. Add the topic to `TOPIC_MAPS` in [`scripts/inventory.mjs`](../scripts/inventory.mjs).
2. Update the relevant table here (and whatever governance page your organisation keeps).
3. For a new **closed** value, confirm `guard-data.mjs` will accept it (it reads `TOPIC_MAPS`,
   so step 1 covers this automatically).
