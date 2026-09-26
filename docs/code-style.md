# Code Style

Formatting is automatic: run `npm run format` (oxfmt, config in `.oxfmtrc.json`). This page covers what a formatter can't fix.

## Names

- Name things for what they hold: `producers`, `scan`, `channel`, not `ps`, `s`, `ch`.
- Single letters are fine only in tiny callbacks where the type is obvious (`(a, b) => a - b`).
- Name magic values: `const TOPICS_IN_LABEL = 3`, not a bare `3`.

## Structure

- One declaration per statement. No `const a = {}, b = {}`.
- No clever one-liners: `(map[k] = map[k] || new Set()).add(v)` becomes a small named helper.
- Never start a line with `;(`. Write a normal statement instead.
- Split long blocks into named functions. A reader should get the flow from the function names alone.
- Prefer `Map`/`Set` over objects used as dictionaries.
- Return early instead of nesting.

## Comments

- Explain why, not what. If a comment restates the code, delete it.
- Keep them short. A paragraph above a function is a smell: move the detail into names, or cut it.
- No changelog history in comments ("backlog #16, Phase 1", "was previously…"). That belongs in git.
- Keep the non-obvious rules and gotchas. Those are the comments worth having.
