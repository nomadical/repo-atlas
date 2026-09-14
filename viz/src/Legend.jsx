import React, { useEffect } from 'react'
import { KIND, EDGE_TYPES, canonKind } from './graph.js'
import { Icon } from './icons.jsx'

// Small color key shown over the graph canvas. Node dots = component type (kind); the Arrows key
// below names each arrow class present on the map. Show/hide toggling now lives in the Filters
// dropdown ("Arrows / integrations"); a type the user has hidden shows greyed here so the key stays
// truthful. Full detail (incl. status styles) lives in the ❓ help overlay.
// Node-kind legend. First caption is the single Type vocabulary — the same categorization the Table
// and Matrix use (the Component Inventory `type`); a backend is just a Service here, not a separate
// type. Second caption is the handful of nodes a diagram must draw that AREN'T Component-Inventory
// components at all (deploy targets, event bus, storage, content repos, internal packages) — context,
// not a type. Only kinds present on the current map render; any present kind outside both lists
// appends after them.
// Type order mirrors the Matrix's TYPE_ROWS (Client, Service, Library, Tests, Third-Party Service,
// Infrastructure, Data, Config, Firmware, Hardware, Assets) so the two surfaces read the same top-to-
// bottom; `component` — the inventory catch-all with no Matrix row — trails the shared vocabulary.
const KIND_GROUPS = [
  ['Type', ['client', 'service', 'library', 'tests', 'external', 'infrastructure', 'data', 'config', 'firmware', 'hardware', 'assets', 'component']],
  ['Diagram context (not inventory components)', ['infra', 'storage', 'bus', 'content', 'package']],
]

export function Legend({ kinds, edgeTypesPresent = [], hiddenEdges }) {
  const present = new Set(edgeTypesPresent)
  const arrows = EDGE_TYPES.filter((e) => present.has(e.key))
  const grouped = new Set(KIND_GROUPS.flatMap(([, m]) => m))
  // A present kind counts as shown under its canonical Type — backend collapses onto `service`,
  // extsvc onto `external` — so a map with backends doesn't append a duplicate "Service" swatch.
  const seen = new Set()
  const isShown = (k) => kinds.has(k) || [...kinds].some((p) => canonKind(p) === k)
  const rest = Object.keys(KIND).filter((k) => isShown(k) && !grouped.has(k) && k === canonKind(k))
  return (
    <div className="legend">
      {KIND_GROUPS.map(([cap, members]) => {
        const shown = members.filter((k) => isShown(k) && KIND[k] && !seen.has(k) && (seen.add(k), true))
        if (!shown.length) return null
        return (
          <React.Fragment key={cap}>
            <div className="legend-cap">{cap}</div>
            {shown.map((k) => (
              <div key={k} className="legend-item">
                <span className="dot" style={{ background: KIND[k].color }} />
                {KIND[k].label}
              </div>
            ))}
          </React.Fragment>
        )
      })}
      {rest
        .filter((k) => !seen.has(k))
        .map((k) => (
          <div key={k} className="legend-item">
            <span className="dot" style={{ background: KIND[k].color }} />
            {KIND[k].label}
          </div>
        ))}
      {arrows.length ? <div className="legend-cap">Arrows</div> : null}
      {arrows.map((e) => {
        const off = !!hiddenEdges?.has(e.key)
        return (
          <div key={e.key} className={'legend-item' + (off ? ' off' : '')} title={off ? `${e.label} — hidden (toggle in Filters)` : e.label}>
            <span className="legend-edge" style={{ borderTopColor: e.color, borderTopStyle: e.dash }} />
            {e.label}
          </div>
        )
      })}
    </div>
  )
}

// Help overlay — a pure-text "how to read & use the map" popup. The visual key (node colours, status
// styles, arrow classes) lives ONLY in the always-visible Legend top-left, so it isn't duplicated (and
// can't drift out of sync) here. Dismiss via the ✕, the backdrop, or Esc.
export function LegendOverlay({ onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="legend-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Help">
      <div className="legend-card" onClick={(e) => e.stopPropagation()}>
        <div className="legend-head">
          <h3>Help</h3>
          <button className="btn ghost" onClick={onClose} aria-label="Close help">
            <Icon name="close" />
          </button>
        </div>
        <div className="legend-help">
          <p className="lg-note">The colour key — node types, status styles and arrow classes — is always shown in the panel at the top-left of the map.</p>
          <section>
            <h4>Reading the map</h4>
            <ul className="lg-tips">
              <li>
                A card's coloured heading and border are its component type; grey tags are the applications it serves; the small grey code is its abbreviation.
              </li>
              <li>
                Cards flag <b>stale</b> repos (no commit in &gt; 120 days), incomplete curation, and open alerts / failing CI.
              </li>
              <li>Hover a card to spotlight its relations; a faint dotted arrow is an inferred, unverified link.</li>
            </ul>
          </section>
          <section>
            <h4>Interacting</h4>
            <ul className="lg-tips">
              <li>Hover or select a card to spotlight it and its direct links; click a cluster to focus its members.</li>
              <li>
                <b>Filters</b> narrows the map (groups, status, health, per-component) and — on the graph — carries the Detail toggles and the Arrows /
                integrations show-hide.
              </li>
              <li>Search highlights matching repos; the view is encoded in the URL, so it's shareable and can be saved as a named View.</li>
              <li>
                The <Icon name="warning" /> pill lists pipeline / data-accuracy warnings.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
