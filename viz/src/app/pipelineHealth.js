// Pipeline-health warnings for the toolbar popover: the assemble step's validation block plus any
// repos the layout left in the Unclassified region.
const UNCLASSIFIED_REGION = 'region-Unclassified'

// [validation key, heading], in display order.
const validationChecks = (org) => [
  ['newlyDiscovered', 'New repos (created on GitHub recently — double-check curation)'],
  ['unclonedOrgRepos', `On ${org || 'the'} org but not cloned locally`],
  ['staleClones', 'Clones with no readable git history'],
  ['duplicateClones', 'Duplicate local clones of one repo (stale pre-rename folder)'],
  ['repoRenames', 'GitHub repos renamed (curated names auto-fixed at runtime)'],
  ['repoMissingOnGitHub', 'GitHub repos not found (deleted or no access)'],
  ['uncuratedRepos', 'Org repos with no inventory topics (not on the map — curate to include)'],
  ['incompleteCuration', 'On the map but half-curated (missing owner/status/description)'],
  ['statusMismatch', 'Archived on GitHub but status not Removed (to be curated)'],
  ['azureStaleMappings', 'Stale Azure name mappings (repo-extra.json)'],
  // Azure drift: what's actually deployed vs what's curated
  ['azureUnmappedApps', 'Deployed in Azure but not on the map'],
  ['azureEnvDrift', 'Environment drift (Azure vs workflows)'],
  ['azureRemovedButDeployed', 'Removed/Sunsetting but recently deployed'],
  ['azureNeedsCuration', 'Deployed services awaiting curation (scaffolded into the table)'],
  ['azureAcrNotInInventory', 'In container registry, no matching GitHub repo'],
]

export function pipelineHealth(data, graph) {
  const validation = data?.validation || {}
  const unclassified = graph.nodes.find((node) => node.id === UNCLASSIFIED_REGION)?.data.members || []
  const items = []
  if (unclassified.length) {
    items.push({ kind: 'Unclassified repos (no cluster assigned)', list: unclassified })
  }
  for (const [key, kind] of validationChecks(data?.org)) {
    if (validation[key]?.length) items.push({ kind, list: validation[key] })
  }
  const count = items.reduce((sum, item) => sum + item.list.length, 0)
  return { items, count }
}
