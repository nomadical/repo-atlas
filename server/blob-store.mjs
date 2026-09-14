/* Azure append-blob adapter for the decision log; same contract as golden-path/lib/store.mjs.
   Lives in server/ (not golden-path/lib) because @azure/* resolves only from server/node_modules.
   Auth is DefaultAzureCredential: workload identity / managed identity, no secret in the image.
   appendBlock is atomic per entry, so concurrent curators need no retries. */
import { AppendBlobClient } from '@azure/storage-blob'
import { DefaultAzureCredential } from '@azure/identity'
import { parseLines } from '../golden-path/lib/store.mjs'

export function blobStore({ url }) {
  const blob = new AppendBlobClient(url, new DefaultAzureCredential())
  return {
    async list() {
      try {
        return parseLines((await blob.downloadToBuffer()).toString('utf8'))
      } catch (e) {
        if (e.statusCode === 404) return [] // no blob yet == empty log, not an error
        throw e // anything else must NOT read as "no decisions" — the route answers 500
      }
    },
    async append(entry) {
      await blob.createIfNotExists() // idempotent; creates the blob as AppendBlob on first write
      const line = JSON.stringify(entry) + '\n'
      await blob.appendBlock(line, Buffer.byteLength(line))
      return entry
    },
  }
}
