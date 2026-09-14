# Data Schema

JSON Schema contracts for the model the viz renders.

| File | Describes |
| --- | --- |
| `fe-architecture.schema.json` | the core model (`fe-architecture.json`) |
| `fe-architecture-extras.schema.json` | the enrichment merged as `extras` (`fe-architecture-extras.json`) |

These assert the **shape and types** of the fields the app depends on; `additionalProperties`
stays open so the pipeline can add fields without churn. They deliberately do **not** encode enum
or referential rules — those live in [`scripts/guard-data.mjs`](../scripts/guard-data.mjs) (closed
type/status enums, edge endpoints resolve, core repos present), and the topic vocabulary in
[`docs/topic-schema.md`](../docs/topic-schema.md).

## Enforcement

- **CI (every PR/push):** `viz/src/schema.test.js` validates the committed data against these
  schemas with ajv (`npm test`).
- **Nightly data refresh:** `guard-data.mjs` re-checks the schema's required fields structurally
  (dependency-free) before committing refreshed data.
- **Editor hints:** `viz/src/types.d.ts` mirrors the schema as TypeScript types, referenced from
  JSDoc in the JS sources.

When the pipeline starts emitting a new field the app relies on, add it here and the types file.
