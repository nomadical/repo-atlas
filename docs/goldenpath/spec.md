# Golden Path compliance — specification

A screen that scores every repository in the organisation against your engineering standards — the
"Golden Path" — and shows how that score moves over time. Route: `?view=golden-path`.

The standards document itself lives wherever your organisation keeps such things (a wiki page, an
ADR) and belongs to whoever owns architecture. This repository holds a machine-readable copy of it
in [`golden-path/rules.json`](../../golden-path/rules.json), so changing a standard is an edit to
data, not a code change and a deploy.

If you don't have such a document, the page is inert rather than wrong: a type with no rules is
reported as out of scope, so an empty `rules.json` scores nothing rather than failing everything.

## Model

**The unit is the GitHub repository**, not the inventory component: topics (`type-*`, `owner-*`,
`status-*`, `app-*`) and the tooling scan both hang off the repository. Components with no
repository of their own — services inside a monorepo — are absent, because there is nothing to scan.

**The estate splits into five segments, and a repository belongs to exactly one**, so the counts add
up to the whole estate and the rows on screen are always the sum of the selected groups.

| Segment | Meaning |
| --- | --- |
| Archived | Archived on GitHub |
| Excluded | A curator ruled the whole repository out |
| Unclassified | No `type-*` topic, so nobody has said what it is |
| Out of scope | A type the Golden Path does not describe |
| Applicable | Live, classified, governed — the default view |

When more than one could claim a repository they resolve in that order. Archived wins over
everything: a dead repository is not a compliance question whatever its topics say.

## Scoring

Rules are selected by component type. A type with no rules is out of scope rather than failing.

| Type | Checks |
| --- | --- |
| Service | Language, Framework, Database, Build, Logging, Tracing |
| Client | Language, Framework |
| Everything else | none |

A scanned value satisfies a rule when it contains the rule's first word **as a whole word** — `Java`
matches `Java 21` but not `JavaScript`, so a Node service cannot read as a conforming Java one. A
rule may offer alternatives separated by ` / `.

Five cell states: conforms, approved deviation, open deviation, not scanned, not applicable.

**The denominator is the applicable checks.** Not-scanned counts as unmet and stays in the
denominator — silence is not conformance. Not-applicable leaves the denominator entirely. Where a
rule is conditional ("if there is a database it is Postgres") an explicit "scanned, there is none"
is not applicable; a fact the scanner could not determine at all is still not-scanned.

Whether a check is collected at all is **derived from the data**, not configured: a column starts
scoring on the first night that carries it.

## Curated decisions

An append-only decision log. The current state is a replay of it, so "who approved this, and when" stays
answerable; a reversal is a new entry, never an edit.

| Type | Effect |
| --- | --- |
| `deviation` | One failing check is accepted; counts as met |
| `not-applicable` | One check does not apply here; leaves the denominator |
| `exclusion` | The whole repository is out |
| `revoke` | Cancels one of the above |

**A decision applies only from the date it was taken**, so replaying an earlier night shows what was
true then rather than back-dating today's approvals across the whole chart.

The author and timestamp come from the verified token, never from the request body. Every writer —
the production route and the dev middleware — validates through one shared function, so the file
cannot gain two dialects.

## History

One entry per night, listing only the repositories that changed since the night before; the first
entry carries everything. Any night is rebuilt by applying entries in order. A night on which
nothing moved is still recorded — the series keeps one point per night.

The nightly job **appends** rather than replaying git, so the work does not grow with the age of the
repository, and it is idempotent: a retried run replaces that date instead of duplicating it.

A guard runs before the commit and fails the run rather than publishing a bad night: dates strictly
increasing and not in the future, coverage not down more than 10%, night count not shrinking. A
deliberate reset is declared with `resetAt` so it does not trip the guard that exists to catch an
accidental one.

The series carries **facts, never verdicts** — rules are applied at read time, so the chart and the
table can never disagree, and a rule change re-judges the whole history.

## Access

| Route | Gate |
| --- | --- |
| `GET /repo-atlas/golden-path/history` | valid realm token |
| `GET /repo-atlas/golden-path/rules` | valid realm token |
| `GET /repo-atlas/api/exceptions` | valid realm token |
| `POST /repo-atlas/api/exceptions` | valid token **and** on the curator list |

These files are deliberately **not** served as static assets: the static root is open, and the
history lists the whole estate's scan results.

Reading decisions needs no curation right — everyone who may read the map may see them. Writing is
limited to addresses in `GP_CURATORS`, matched only against a verified email or the
directory-assigned username, and an empty list grants nobody. A valid token without the right gets
403, distinct from 401, so the screen can tell "sign in again" from "ask for the right".

The screen draws no editing controls for a reader who may not curate. **That is a courtesy, not the
gate** — the gate is on the route and does not care what the client rendered.

## Configuration

| Variable | Effect |
| --- | --- |
| `GP_CURATORS` | Comma-separated addresses allowed to write. Empty = nobody (fail closed) |
| `GP_DECISION_LOG` | Path to durable decision log storage. Unset = inside the image, lost on restart (warned at startup) |

## Decisions taken, with reasons

**Libraries are out of scope.** The document describes FE applications, mobile applications and BE
services, says nothing about shared libraries, and leaves what it does not describe to the team.
Applying client rules to them failed token packages for having no React, which was never asked of
them.

**`arch-map-ignore` does not affect this screen.** Keeping a repository off the architecture map is
a different question from whether the Golden Path applies to it. The flag is recorded and not read.

**Not-scanned counts as unmet, unclassified does not.** Firmware has no rules because that was
decided; an unclassified repository has none because nobody has said what it is. The first is an
answer, the second is its absence, so they are separate groups with separate toggles.

**Approved deviations are shown off the traffic-light axis** (violet, not green or amber): a curated
decision is a human's, not a state of the code.

**The detail panel is non-modal** — no backdrop, no focus trap; the table stays live and a click
outside closes it. Known cost: it overlaps the right-hand columns.

**Interface copy is English only.**

## Rejected alternatives

**Overlapping labels instead of exclusive segments.** Counts would sum to more than the estate and
the row count would never match the selection — that needs a footnote, and a footnote means the
model is wrong.

**The inventory component as the unit.** Topics and scans hang off the repository. Cost accepted:
components without a repository are absent.

**A git branch as decision log storage.** It works, but a token that can write to this repository means
the "approve" button can also rewrite the pipeline's own scripts. Azure append blob was chosen
instead: managed identity, no long-lived secret in the container.

**Serving the screen as a static file.** Verified against the dev host: the gateway routes but does
not authenticate, so the history would have become public — the same data that is closed behind a
token on the model route.

**A second, standalone implementation of the screen.** It shared logic but not interface, and had
diverged within a day; parity was unverifiable by anything but eyes.
