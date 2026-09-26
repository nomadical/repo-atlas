/* Curated decision log. Adapter contract (Azure append blob is the intended one): append is
   atomic per entry with no read-modify-write; list() may be stale or fail without taking the
   page down; errors throw so the route answers 500 instead of claiming a save. */
import fs from 'node:fs'

// Warns with the real 1-based line number. Only objects are entries: a line that parses to
// `null` or a number would crash the replay, so it is skipped like a malformed one.
export function parseLines(text) {
  const entries = []
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return
    const entry = parseLine(line)
    if (entry && typeof entry === 'object') entries.push(entry)
    else console.warn(`skipping malformed line ${index + 1}`)
  })
  return entries
}

function parseLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

export function fileStore({ path }) {
  return {
    list() {
      try {
        return parseLines(fs.readFileSync(path, 'utf8'))
      } catch (error) {
        // No file yet is an empty log. Any other fs error must not read as "no decisions".
        if (error.code === 'ENOENT') return []
        throw error
      }
    },
    append(entry) {
      fs.appendFileSync(path, JSON.stringify(entry) + '\n')
      return entry
    },
  }
}
