// Runs async thunks with bounded concurrency. Results come back in the thunks' order, whatever
// order they finish in, so callers that apply them in order write deterministic output.
export const runPooled = async (thunks, limit) => {
  const results = Array.from({ length: thunks.length })
  let nextIndex = 0
  const worker = async () => {
    for (;;) {
      const index = nextIndex++
      if (index >= thunks.length) return
      results[index] = await thunks[index]()
    }
  }
  const workerCount = Math.min(limit, thunks.length)
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}
