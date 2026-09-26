---
name: Repo Atlas
description: Internal architecture map of repos, services and their links.
colors:
  brand: "#0aa8d2"
  brand-strong: "#0086a8"
  brand-dark: "#005168"
  brand-ink: "#007391"
  brand-solid: "#007391"
  canvas: "#f4f6fa"
  card: "#ffffff"
  ink: "#1f2430"
  muted: "#5f6b80"
  border: "#d9dee9"
  chip: "#eef1f6"
  focus: "#007391"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
  title:
    fontSize: "13px"
    fontWeight: 600
  label:
    fontSize: "10px"
    fontWeight: 700
    letterSpacing: "0.5px"
rounded:
  chip: "5px"
  card: "10px"
---

# Design System: Repo Atlas

## Overview

A dense engineering tool. A teal gradient toolbar sits over a quiet canvas of white, kind-coded cards. Colour encodes kind, lifecycle status and health; everything else stays neutral. Tokens live on `.app` / `.app.dark` in `viz/src/styles.css`. Kind hues live in `KIND` in `viz/src/graph.js`.

## Colors

- **Brand.** `--brand`, `--brand-strong` and `--brand-dark` fill the toolbar, matrix headers and the gate. They do not change between themes. `--brand-ink` is brand-coloured text (`#007391` light, `#5dcbe8` dark). `--brand-solid` sits behind white text on buttons and "on" chips. `--brand-tint` is the hover wash.
- **Neutrals.** Canvas, card, panel, `--ink`, `--muted`, `--bd` and `--chip`. All text, including `--muted`, is at least 4.5:1 on every surface it sits on.
- **Kind.** Each kind has one hue in `KIND`. The raw hue colours the card's top border, legend dots, the minimap and the panel's top strip. Text in a kind colour (`.node-kind`, `.panel-eyebrow`, `.region-label`) reads `--kind` and clamps its OKLCH lightness to `--kind-l-min`/`--kind-l-max`. That keeps the hue readable on light and on dark.
- **Lifecycle status.** Each status (`current`, `planned`, `sunsetting`, `removed`) has a `--st-*` token that colours borders and chip fills, plus a `--st-*-on` token for text on that fill. `StatusChip` in `ui.jsx` sets classes and never literal colours.
- **Semantic pills.** `warn`, `danger`, `ok`, `info`, `violet` and `neutral` each have `-bg` and `-ink` tokens (some also have `-bd`). Each one has its own dark value. `--ok-solid` and `--danger-solid` are fills behind white text.
- **Tags.** Tag fills come from `config.json` `tagColors`. A 25% black inset scrim keeps the white label readable on any fill.

## Typography

One system sans. The scale is dense: 10px uppercase labels (kind, section heads), 11–12px body and metadata, 13px card titles, 18px panel headings. Nothing is smaller than 10px except the 9px flags that sit inside cards.

## Layout

The toolbar wraps instead of scrolling sideways. Below 1600px it drops the tagline and data age to give the title room. Below 1060px it drops the text labels. On phones (560px and below) it drops separators, carets and the search glyph so it fits in two rows. The details panel shrinks before the page grows wider.

## Components

- **Card top border (4px)** = kind colour. **Dashed** outline = sunsetting, **dotted** = planned, faded with a struck-through title = removed.
- **Matrix chip left border (3px)** = lifecycle status. It is solid, dashed (sunsetting) or dotted (planned), and removed chips are also struck through, so status never depends on colour alone.
- **Panel top strip (4px)** = kind of the selected item. No other decorative stripes.
- **Focus.** 2px `--focus` outline, offset 2px. React Flow nodes draw the ring on `.node-card` or on the region. Inside the toolbar the ring is white with a 2px `--brand-dark` inner edge. The panel resizer shows a 3px focus-coloured bar.
- **Toolbar dropdowns** are disclosures (`aria-expanded` + `aria-controls`), not ARIA menus.

## Do's and Don'ts

- Do add a token pair (fill + ink) with a dark value instead of a literal hex.
- Do pass colours from data to CSS as `--kind` (or another custom property), not as inline `color`, so CSS can make the text readable.
- Don't put text directly on a raw kind or tag hue.
- Don't animate movement under `prefers-reduced-motion`. Colour, shadow and fade feedback stay.
