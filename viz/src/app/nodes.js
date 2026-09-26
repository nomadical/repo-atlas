// Resolve a saved ?sel= id to a card node. Old links and saved views used the repo folder before
// the serviceId became the node id, so both still resolve.
export const matchSelNode = (node, id) =>
  node.type === 'card' &&
  (node.id === id || node.data.repo?.folder === id || node.data.repo?.serviceId === id)

export const findSelNode = (nodes, id) => nodes.find((node) => matchSelNode(node, id))

// Truthy when the client repo has screens to drill into.
export const clientScreenCount = (data, folder) => data?.extras?.screens?.perRepo?.[folder]?.screens?.length

// Card titles may carry a manual line break.
export const singleLineTitle = (title) => String(title).replace('\n', ' ')
