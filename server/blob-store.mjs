/* Azure append-blob adapter for the decision log; same contract as golden-path/lib/store.mjs.
   Lives in server/ (not golden-path/lib) because @azure/* resolves only from server/node_modules.
   Auth is DefaultAzureCredential: workload identity / managed identity, no secret in the image.
   appendBlock is atomic per entry, so concurrent curators need no retries. */
import { AppendBlobClient } from '@azure/storage-blob'
import { DefaultAzureCredential } from '@azure/identity'
import { parseLines } from '../golden-path/lib/store.mjs'

const NOT_FOUND = 404

export function blobStore({ url }) {
  const blob = new AppendBlobClient(url, new DefaultAzureCredential())
  return {
    async list() {
      try {
        const contents = await blob.downloadToBuffer()
        return parseLines(contents.toString('utf8'))
      } catch (error) {
        // No blob yet is an empty log. Anything else must not read as "no decisions".
        if (error.statusCode === NOT_FOUND) return []
        throw error
      }
    },
    async append(entry) {
      // Idempotent; the first write creates the blob as an AppendBlob.
      await blob.createIfNotExists()
      const line = JSON.stringify(entry) + '\n'
      await blob.appendBlock(line, Buffer.byteLength(line))
      return entry
    },
  }
}
