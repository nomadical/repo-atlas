// Standalone publish: bakes the current data into the built viz bundle and copies it to
// published/. Mirrors the dev-server Publish button (vite.config.mjs) without a server, so CI can
// produce the deployable static site.
import fs from 'node:fs'
import path from 'node:path'
import { AUDIT } from './_paths.mjs'

const dist = path.join(AUDIT, 'viz', 'dist')
const published = path.join(AUDIT, 'published')

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(AUDIT, name), 'utf8'))

const readOptionalJson = (name) => {
  try {
    return readJson(name)
  } catch {
    return null
  }
}

if (!fs.existsSync(dist)) {
  console.error('viz/dist not found — run `npm --prefix viz ci && npm --prefix viz run build` first')
  process.exit(1)
}

const main = readJson('fe-architecture.json')
const extras = readOptionalJson('fe-architecture-extras.json')
// Admin-curated app config (e.g. the editable page title), not pipeline output.
const config = readOptionalJson('config.json')
// The raw curated files let the Admin panel edit them in read-only deploys and download a complete,
// committable file: the merged inventory alone can't round-trip.
const inventoryExtra = readOptionalJson('inventory-extra.json')
const serviceMap = readOptionalJson('service-map.json')

fs.writeFileSync(
  path.join(dist, 'data.json'),
  JSON.stringify({ ...main, extras, config, inventoryExtra, serviceMap }),
)

fs.rmSync(published, { recursive: true, force: true })
fs.cpSync(dist, published, { recursive: true })
console.log('bundled -> published/')
