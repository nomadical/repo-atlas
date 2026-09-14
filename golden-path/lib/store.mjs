/* Curated decision log. Adapter contract (Azure append blob is the intended one): append is
   atomic per entry with no read-modify-write; list() may be stale or fail without taking the
   page down; errors throw so the route answers 500 instead of claiming a save. */
import fs from 'node:fs'

export function parseLines(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((l, i) => {
      try { return JSON.parse(l) } catch { console.warn(`skipping malformed line ${i + 1}`); return null }
    })
    .filter(Boolean)
}

export function fileStore({ path }) {
  return {
    list() {
      try {
        return parseLines(fs.readFileSync(path, 'utf8'))
      } catch (e) {
        if (e.code === 'ENOENT') return [] // no file yet == empty log, not an error
        throw e // any other fs error must NOT read as "no decisions" — the route answers 500
      }
    },
    append(entry) {
      fs.appendFileSync(path, JSON.stringify(entry) + '\n')
      return entry
    },
  }
}
