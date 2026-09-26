/* Curated decision log. Adapter contract (Azure append blob is the intended one): append is
   atomic per entry with no read-modify-write; list() may be stale or fail without taking the
   page down; errors throw so the route answers 500 instead of claiming a save. */
import fs from 'node:fs'

export function parseLines(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch {
        console.warn(`skipping malformed line ${index + 1}`)
        return null
      }
    })
    .filter(Boolean)
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
