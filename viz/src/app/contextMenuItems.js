// Items for the admin right-click menu. Regions get geometry actions, cards get navigation and
// links, the empty pane gets whole-view layout actions.
import { docHref } from '../ui.jsx'
import { clientScreenCount, singleLineTitle } from './nodes.js'

const openInNewTab = (url) => window.open(url, '_blank', 'noopener')

function regionItems(node, actions) {
  return [
    { heading: node.data.label + ' group' },
    { label: 'Select group', icon: 'box', onClick: () => actions.onNodeClick(null, node) },
    {
      label: 'Resize to fit members',
      icon: 'integrations',
      onClick: () => actions.resizeRegionToFit(node.id, node.data.members),
    },
    {
      label: 'Reset box to auto',
      icon: 'dot',
      onClick: () => actions.clearRegionGeom(node.id),
      disabled: !actions.modeLayout[node.id],
    },
    { separator: true },
    { label: 'Edit group descriptions…', icon: 'edit', onClick: actions.openAdmin },
  ]
}

function cardItems(node, actions) {
  const card = node.data
  const repoUrl = card.inventory?.repo || card.repo?.remote?.replace(/\.git$/, '') || null
  const docUrl = docHref(card.inventory?.doc, card.inventory?.docUrl, actions.config?.docSearchUrl)
  const canDrill = card.kind === 'client' && clientScreenCount(actions.data, card.repo?.folder)
  return [
    { heading: singleLineTitle(card.title || '') },
    { label: 'Details', icon: 'more', onClick: () => actions.onNodeClick(null, node) },
    { label: 'Focus / frame', icon: 'search', onClick: () => actions.frameNodes([node.id]) },
    canDrill
      ? {
          label: 'View screens →',
          icon: 'integrations',
          onClick: () => actions.setClientId(card.repo.folder),
        }
      : null,
    { separator: true },
    {
      label: 'Open repo on GitHub',
      icon: 'github',
      onClick: () => openInNewTab(repoUrl),
      disabled: !repoUrl,
    },
    {
      label: 'Open documentation',
      icon: 'book',
      onClick: () => openInNewTab(docUrl),
      disabled: !docUrl,
    },
  ]
}

function canvasItems(actions) {
  return [
    { heading: 'Canvas' },
    { label: 'Fit view', icon: 'search', onClick: actions.fitView },
    { label: 'Auto-arrange this view', icon: 'rocket', onClick: actions.autoArrange },
    { separator: true },
    { label: 'Reset all layout', icon: 'close', danger: true, onClick: actions.resetLayout },
  ]
}

export function contextMenuItems(target, actions) {
  if (!target) return []
  const node = target.node
  if (node?.type === 'region') return regionItems(node, actions)
  if (node) return cardItems(node, actions)
  return canvasItems(actions)
}
