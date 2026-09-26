// Small pure rules from assemble.mjs, kept here so they can be tested without running the pipeline.

// Adds a token to a lowercased-token index. The first entry for a token wins, whatever its case.
export function putFirst(index, token, value) {
  if (!token) return
  const key = String(token).toLowerCase()
  if (!index.has(key)) index.set(key, value)
}
