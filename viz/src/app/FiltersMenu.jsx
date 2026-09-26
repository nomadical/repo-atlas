// The Filters dropdown: faceted narrowing (group / status / health / components, subtractive) plus
// the graph detail layers and arrow toggles, in one menu.
import { LAYERS, edgeTypesFor } from '../graph.js'
import { Dropdown, FilterRow } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { AT_RISK } from './urlState.js'

const AT_RISK_COLOR = '#b3261e'

function ResetOrHint({ isDefaultFilters, resetFilters }) {
  if (isDefaultFilters) {
    return (
      <div className="dd-hint">
        Default view. Tick a group or status to narrow, or untick every group to show all.
      </div>
    )
  }
  return (
    <button className="dd-item dd-clear" onClick={resetFilters}>
      <Icon name="close" /> Reset filters (default view)
    </button>
  )
}

function GroupSection({ groups, clusterDefs, selected, toggleFacet }) {
  return (
    <>
      <div className="dd-group">Group (team)</div>
      {groups.map((label) => {
        const cluster = clusterDefs.find((c) => c.label === label)
        return (
          <FilterRow
            key={'g:' + label}
            checked={selected.has(label)}
            onChange={() => toggleFacet('group', label)}
          >
            {cluster?.color ? <span className="tagdot" style={{ background: cluster.color }} /> : null}
            {label}
          </FilterRow>
        )
      })}
    </>
  )
}

function StatusSection({ statuses, selected, toggleFacet }) {
  if (!statuses.length) return null
  return (
    <>
      <div className="dd-group">Status</div>
      {statuses.map((status) => (
        <FilterRow
          key={'s:' + status}
          checked={selected.has(status)}
          onChange={() => toggleFacet('status', status)}
        >
          {status}
        </FilterRow>
      ))}
    </>
  )
}

function HealthSection({ selected, toggleFacet }) {
  return (
    <>
      <div className="dd-group">Health</div>
      <FilterRow checked={selected.has(AT_RISK)} onChange={() => toggleFacet('health', AT_RISK)}>
        <span className="tagdot" style={{ background: AT_RISK_COLOR }} />
        At-risk only (alerts / failing CI)
      </FilterRow>
    </>
  )
}

// Graph-only, additive: each toggle draws an extra class of nodes on top of the base map. Named
// "Detail", not "Layer", because "Layer" was confused with the inventory's Type.
function DetailSection({ layers, toggleLayer }) {
  return (
    <>
      <div className="dd-group">Detail (graph only)</div>
      <div className="dd-subhint">
        Each adds a class of nodes on top of the base map. Untick all to return to the base map.
      </div>
      {LAYERS.map((layer) => (
        <FilterRow
          key={'l:' + layer.key}
          checked={layers[layer.key]}
          onChange={(on) => toggleLayer(layer.key, on)}
        >
          {layer.label}
        </FilterRow>
      ))}
    </>
  )
}

// The graph offers every arrow class drawn; the Integrations table only the protocols present
// there. Other views have no arrows.
function arrowKeysForView(view, graphEdgeTypes, integrationEdgeTypes) {
  if (view === 'graph') return graphEdgeTypes || []
  if (view === 'integrations') return integrationEdgeTypes
  return []
}

// Hiding an arrow type also drops nodes it leaves edge-less (buildGraph prunes orphans), so hiding
// Kafka removes the bus node too.
function ArrowSection({ arrowKeys, config, hiddenEdges, toggleEdge }) {
  if (!arrowKeys.length) return null
  const shownTypes = edgeTypesFor(config).filter((edgeType) => arrowKeys.includes(edgeType.key))
  return (
    <>
      <div className="dd-group">Arrows / integrations</div>
      {shownTypes.map((edgeType) => (
        <FilterRow
          key={'e:' + edgeType.key}
          checked={!hiddenEdges.has(edgeType.key)}
          onChange={() => toggleEdge(edgeType.key)}
        >
          <span
            className="legend-edge"
            style={{ borderTopColor: edgeType.color, borderTopStyle: edgeType.dash }}
          />
          {edgeType.label}
        </FilterRow>
      ))}
    </>
  )
}

// A hidden component stays listed so it can be re-checked. Keys are lowercased inventory names,
// matching matchInventory and buildGraph.
function ComponentsSection({
  components,
  hidden,
  toggleFacet,
  setComponentsHidden,
  compFilter,
  setCompFilter,
}) {
  if (!components.length) return null
  const needle = compFilter.trim().toLowerCase()
  const shown = components.filter((name) => name.toLowerCase().includes(needle))
  return (
    <>
      <div className="dd-group">
        Components
        {/* No "hide all" on purpose: unchecking every component shows all, same as checking every
            one (see graph.js), so it would be a no-op. */}
        {hidden.size ? (
          <span className="dd-group-actions">
            <button className="dd-linkbtn" onClick={() => setComponentsHidden([...hidden], false)}>
              Show all
            </button>
          </span>
        ) : null}
      </div>
      <input
        className="dd-filter"
        type="search"
        value={compFilter}
        placeholder="Filter components…"
        onChange={(e) => setCompFilter(e.target.value)}
      />
      <div className="dd-scroll">
        {shown.map((name) => (
          <FilterRow
            key={'c:' + name}
            checked={!hidden.has(name.toLowerCase())}
            onChange={() => toggleFacet('hidden', name.toLowerCase())}
          >
            {name}
          </FilterRow>
        ))}
      </div>
    </>
  )
}

export default function FiltersMenu(props) {
  const { view, facets, facetOptions, toggleFacet, filterCount } = props
  const arrowKeys = arrowKeysForView(view, props.graphEdgeTypes, props.integrationEdgeTypes)
  return (
    <Dropdown
      className="filters-dd"
      label="Filters"
      badge={filterCount || null}
      title="Narrow or detail the map — groups, status, health, layers"
    >
      <ResetOrHint isDefaultFilters={props.isDefaultFilters} resetFilters={props.resetFilters} />
      <GroupSection
        groups={facetOptions.group}
        clusterDefs={props.clusterDefs}
        selected={facets.group}
        toggleFacet={toggleFacet}
      />
      <StatusSection statuses={facetOptions.status} selected={facets.status} toggleFacet={toggleFacet} />
      <HealthSection selected={facets.health} toggleFacet={toggleFacet} />
      {view === 'graph' ? <DetailSection layers={props.layers} toggleLayer={props.toggleLayer} /> : null}
      <ArrowSection
        arrowKeys={arrowKeys}
        config={props.config}
        hiddenEdges={props.hiddenEdges}
        toggleEdge={props.toggleEdge}
      />
      <ComponentsSection
        components={facetOptions.components}
        hidden={facets.hidden}
        toggleFacet={toggleFacet}
        setComponentsHidden={props.setComponentsHidden}
        compFilter={props.compFilter}
        setCompFilter={props.setCompFilter}
      />
    </Dropdown>
  )
}
