import React, { useEffect, useState } from 'react'
import { KIND, edgeTypesFor, canonKind } from './graph.js'
import { Icon } from './icons.jsx'

// Colour key over the graph canvas: node dots per component type, then the arrow classes on the
// map. An arrow class hidden in Filters shows greyed so the key stays truthful.
//
// "Type" is the same vocabulary as the Table and Matrix (in the Matrix's TYPE_ROWS order, with the
// `component` catch-all last). "Diagram context" nodes aren't inventory components at all. Only
// kinds present on the map render; any other present kind is appended after both groups.
const KIND_GROUPS = [
  [
    'Type',
    [
      'client',
      'service',
      'library',
      'tests',
      'external',
      'infrastructure',
      'data',
      'config',
      'firmware',
      'hardware',
      'assets',
      'component',
    ],
  ],
  ['Diagram context (not inventory components)', ['infra', 'storage', 'bus', 'content', 'package']],
]
const GROUPED_KINDS = new Set(KIND_GROUPS.flatMap(([, members]) => members))
// The key starts collapsed so it doesn't cover the first lane; the viewer's choice sticks.
const LEGEND_OPEN_KEY = 'archmap-legend-open'

function readLegendOpen() {
  try {
    return localStorage.getItem(LEGEND_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function saveLegendOpen(open) {
  try {
    localStorage.setItem(LEGEND_OPEN_KEY, open ? '1' : '0')
  } catch {}
}

// A present kind also counts under its canonical type (backend -> service, extsvc -> external), so a
// map with backends doesn't get a duplicate "Service" swatch.
function isKindShown(kinds, kind) {
  return kinds.has(kind) || [...kinds].some((present) => canonKind(present) === kind)
}

function shownKindGroups(kinds) {
  const alreadyShown = new Set()
  const groups = []
  for (const [caption, members] of KIND_GROUPS) {
    const shown = []
    for (const kind of members) {
      if (!isKindShown(kinds, kind) || !KIND[kind] || alreadyShown.has(kind)) continue
      alreadyShown.add(kind)
      shown.push(kind)
    }
    if (shown.length) groups.push({ caption, shown })
  }
  return groups
}

function ungroupedShownKinds(kinds) {
  return Object.keys(KIND).filter(
    (kind) => isKindShown(kinds, kind) && !GROUPED_KINDS.has(kind) && kind === canonKind(kind),
  )
}

function KindSwatch({ kind }) {
  return (
    <div className="legend-item">
      <span className="dot" style={{ background: KIND[kind].color }} />
      {KIND[kind].label}
    </div>
  )
}

function ArrowSwatch({ edgeType, hidden }) {
  return (
    <div
      className={'legend-item' + (hidden ? ' off' : '')}
      title={hidden ? `${edgeType.label} — hidden (toggle in Filters)` : edgeType.label}
    >
      <span
        className="legend-edge"
        style={{ borderTopColor: edgeType.color, borderTopStyle: edgeType.dash }}
      />
      {edgeType.label}
    </div>
  )
}

export function Legend(props) {
  const [open, setOpen] = useState(readLegendOpen)
  const toggle = () => {
    setOpen(!open)
    saveLegendOpen(!open)
  }
  return (
    <div className={'legend' + (open ? ' open' : '')}>
      <button className="legend-toggle" onClick={toggle} aria-expanded={open}>
        <Icon name="caretDown" className="legend-caret" />
        Legend
      </button>
      {open ? <LegendKey {...props} /> : null}
    </div>
  )
}

function LegendKey({ kinds, edgeTypesPresent = [], hiddenEdges, config }) {
  const presentEdgeTypes = new Set(edgeTypesPresent)
  const arrows = edgeTypesFor(config).filter((edgeType) => presentEdgeTypes.has(edgeType.key))
  return (
    <>
      {shownKindGroups(kinds).map(({ caption, shown }) => (
        <React.Fragment key={caption}>
          <div className="legend-cap">{caption}</div>
          {shown.map((kind) => (
            <KindSwatch key={kind} kind={kind} />
          ))}
        </React.Fragment>
      ))}
      {ungroupedShownKinds(kinds).map((kind) => (
        <KindSwatch key={kind} kind={kind} />
      ))}
      {arrows.length ? <div className="legend-cap">Arrows</div> : null}
      {arrows.map((edgeType) => (
        <ArrowSwatch key={edgeType.key} edgeType={edgeType} hidden={!!hiddenEdges?.has(edgeType.key)} />
      ))}
    </>
  )
}

// Text-only "how to read and use the map" popup. The colour key deliberately lives only in the
// always-visible Legend so the two can't drift apart.
export function LegendOverlay({ onClose }) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])
  return (
    <div className="legend-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Help">
      <div className="legend-card" onClick={(event) => event.stopPropagation()}>
        <div className="legend-head">
          <h3>Help</h3>
          <button className="btn ghost" onClick={onClose} aria-label="Close help">
            <Icon name="close" />
          </button>
        </div>
        <div className="legend-help">
          <p className="lg-note">
            The colour key — node types, status styles and arrow classes — is in the Legend at the top-left of
            the map.
          </p>
          <section>
            <h4>Reading the map</h4>
            <ul className="lg-tips">
              <li>
                A card's coloured heading and border are its component type; grey tags are the applications it
                serves; the small grey code is its abbreviation.
              </li>
              <li>
                Cards flag <b>stale</b> repos (no commit in &gt; 120 days), incomplete curation, and open
                alerts / failing CI.
              </li>
              <li>
                Hover a card to spotlight its relations; a faint dotted arrow is an inferred, unverified link.
              </li>
            </ul>
          </section>
          <section>
            <h4>Interacting</h4>
            <ul className="lg-tips">
              <li>
                Hover or select a card to spotlight it and its direct links; click a cluster to focus its
                members.
              </li>
              <li>
                <b>Filters</b> narrows the map (groups, status, health, per-component) and — on the graph —
                carries the Detail toggles and the Arrows / integrations show-hide.
              </li>
              <li>
                Search highlights matching repos; the view is encoded in the URL, so it's shareable and can be
                saved as a named View.
              </li>
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
