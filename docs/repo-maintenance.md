# Repo Maintenance for the Architecture Map

The architecture map is **built live from each repo's own GitHub metadata** — descriptions, topics,
and org custom properties — re-read on every nightly refresh.
There is no central spreadsheet to edit: **you curate your repo on GitHub, and the map updates
itself.** This page is the practical checklist for repo owners. For the exact field-by-field
schema (closed enums, display names), see [`topic-schema.md`](topic-schema.md).

> **The one rule:** every active repo should be either **curated** (so it appears correctly) or
> explicitly **excluded** (archived or `arch-map-ignore`). A repo that is neither is
> a gap — it shows up in the weekly [curation backlog](#staying-on-top-of-it).

## What a fully-curated repo has

| # | What | Where | Required? |
| --- | --- | --- | --- |
| 1 | **One-line description** | repo *About* field | **Yes** — it's the card subtitle **and** the "what it is" purpose text (no central override; write it here) |
| 2 | **`type-*` topic** | repo topics | **Yes** — no type, no map presence |
| 3 | **`status-*` topic** | repo topics | **Yes** |
| 4 | **`owner-*` topic** | repo topics | **Yes** — sets the cluster |
| 5 | **`app-*` topic(s)** | repo topics | If it serves an application |
| 6 | **`abbreviation` + `technical-contact`** | org custom properties | Recommended |
| 7 | **`doc-url` + `doc-label`** | org custom properties | If the component has a doc page |
| 8 | **`cluster-*` topic** | repo topics | Only if cross-cutting |

Items 1–4 are the minimum for a complete record. A repo with a `type-*` but missing any of
description / `status` / `owner` renders on the map *with gaps* and is flagged
"half-curated" in the [health pill](#staying-on-top-of-it).

> **Backends too, automatically.** A Java (or other non-JS/TS) service joins the map the moment you
> give it a `type-service` topic — the nightly clones it and reads its `build.gradle`/`pom.xml` for
> the tooling chips. No list to add it to. Renames are followed automatically, so moving or renaming
> a backend needs no edit anywhere.

## How to curate a repo (2 minutes)

1. **Description** — repo home page → ⚙ *Edit* next to *About*. One line, present tense, what it
   *is* — not "Repo for X". Good: *"Booking portal frontend for pharma customers."*
2. **Topics** — same *About* dialog → *Topics*. Add the set below. Topics are **lowercase,
   dashes only** (a GitHub rule); a team name with dots maps dots → dashes
   (`Platform.Core` → `owner-platform-core`).
3. **Custom properties** — Org → Settings → Repository properties, or the repo's *Settings →
   Custom properties* tab. Set `abbreviation` (e.g. `ORD`) and `technical-contact` (a name).
   For the Documentation link shown on the map, set `doc-url` to the page URL and `doc-label` to the
   text to show (e.g. *Orders Domain Model*); a `doc-label` with no `doc-url` routes to a wiki
   quick-search. Custom-property values cap at **75 characters**, so if your wiki has a short
   canonical URL form — a page id without the title slug, which still redirects — use it. A long URL
   with a trailing title slug is rejected once it passes 75 characters, and makes values
   inconsistent across repos:

   ```
   ✗ https://wiki.example.com/spaces/ARCH/pages/2943549759/Orders+Domain+Model   (rejected, too long)
   ✓ https://wiki.example.com/spaces/ARCH/pages/2943549759                       (short form)
   ```

   **Optional owner-owned overrides** (set only if you want to own these on your repo — otherwise
   the map's curated `repo-extra.json` fallback is used and nothing changes):
   `api-url` (your primary API origin, `{env}` template ok — powers the FE→backend trace and
   Swagger deep-links), `live-url` (where the app runs), `swagger-url` (API docs). For cloud
   resources:
   `azure-app-key` (your `{env}<key>website` static-site key, space-separated for several) and
   `acr-image` (the container image name if it differs from the component). A just-set value takes
   effect on the next nightly refresh.

### The topics, at a glance

| Topic | Pick from | Notes |
| --- | --- | --- |
| `type-*` | `client` · `service` · `library` · `assets` · `tests` · `third-party-service` · `firmware` · `infra` · `hardware` · `data` · `config` | **Closed list** — a typo fails the nightly build |
| `status-*` | `current` · `planned` · `sunsetting` · `removed` | **Closed list**. Keep it honest — a `sunsetting` repo still shipping is flagged as drift |
| `owner-*` | your team (`owner-iss`, `owner-css-at`, …) | Open — new teams welcome |
| `app-*` | one per app served (`app-skytrack`, `app-ci`, …) | Open — new apps auto-title |
| `cluster-*` | `shared` · `iss` · `css` · `iot` | **Only** for cross-cutting components (e.g. a shared library); overrides the owner→cluster default |

See [`topic-schema.md`](topic-schema.md) for the full enum, display names, and how to add a new
team/app/type.

## Excluding a repo (it's not an architecture component)

Not every repo is a component. PoCs, demos, scratch repos, dev tooling, and one-off scripts should
**not** clutter the map or nag in the backlog. Two ways out:

- **Archive it** (Settings → Archive) — for repos that are truly done. Archived repos auto-drop
  from the map and the backlog. Preferred for dead repos over `status-removed`.
- **Add the `arch-map-ignore` topic** — for live repos that are genuinely not components.

## Hygiene rules

- **Keep `status-*` current.** When a component is deprecated, set `status-sunsetting`; when it's
  gone, `status-removed` (or archive the repo). The map styles these (dashed amber / struck-through)
  and flags "removed but still deploying" as drift.
- **Naming.** kebab-case; `*-client` for frontends, `*-service` for backends. Renames are tracked,
  but consistent names keep the map readable.
- **Declare shared dependencies honestly.** The map draws version-drift edges from `package.json`
  for the packages listed in `config.json` `uiPackages`; a consumer lagging the latest version turns
  its edge red.
- **Don't let a repo go silent.** No commit in >120 days flags the card as *stale*.
- **Things that can't live on a repo** — technical contact for a non-repo third-party service,
  intro/sunset dates, doc links — go in
  [`inventory-extra.json`](../inventory-extra.json). Topics always win over its `fallback` block, so
  fill the real topics and delete the fallback.

## Staying on top of it

- **Weekly backlog issue** — the [curation report](../scripts/curation-report.mjs) runs every
  Monday and opens/updates a single tracking issue, grouped by owning team, listing uncurated and
  half-curated repos. Run it locally any time: `node scripts/curation-report.mjs`.
- **In-app health pill** — the ⚠ pill on the live map surfaces uncurated repos, half-curated
  components, and Azure/inventory drift in real time.

## Keep this in sync

This page, [`topic-schema.md`](topic-schema.md), `TOPIC_MAPS` in
[`scripts/inventory.mjs`](../scripts/inventory.mjs), and the `owners` / `applications` vocabularies
in `config.json` must agree. Changing the schema? Update all of them (see *Changing the schema* in
`topic-schema.md`).
