// Small pure rules from assemble.mjs, kept here so they can be tested without running the pipeline.

// Adds a token to a lowercased-token index. The first entry for a token wins, whatever its case.
export function putFirst(index, token, value) {
  if (!token) return
  const key = String(token).toLowerCase()
  if (!index.has(key)) index.set(key, value)
}

// Records one REST pair seen in code. A curated CSV row for the pair is confirmed; a pair already
// derived from another consumer config merges into that derived row. Returns 'confirmed',
// 'merged' or 'added' (the caller then keeps `row`).
export function recordRestPair({ curatedByKey, derivedByKey }, key, row) {
  if (derivedByKey.has(key)) return 'merged'
  const curated = curatedByKey.get(key)
  if (curated) {
    curated.verified = true
    curated.via = 'code'
    // Keeps the row's provenance: the Admin panel writes curated rows back to integrations.csv.
    curated.curated = true
    if (!curated.channel) curated.channel = row.channel
    derivedByKey.set(key, curated)
    return 'confirmed'
  }
  derivedByKey.set(key, row)
  return 'added'
}
