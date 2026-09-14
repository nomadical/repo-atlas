// Standalone "publish": bake the current data into a freshly-built viz bundle and copy it
// to published/. Mirrors the dev-server Publish button (vite.config.mjs) but needs no server,
// so CI (and `npm run bundle`) can produce the deployable static site.
import fs from 'node:fs'
import path from 'node:path'
import { AUDIT } from './_paths.mjs'

const dist = path.join(AUDIT, 'viz', 'dist')
const published = path.join(AUDIT, 'published')

if (!fs.existsSync(dist)) {
  console.error('viz/dist not found — run `npm --prefix viz ci && npm --prefix viz run build` first')
  process.exit(1)
}

const main = JSON.parse(fs.readFileSync(path.join(AUDIT, 'fe-architecture.json'), 'utf8'))
let extras = null
try { extras = JSON.parse(fs.readFileSync(path.join(AUDIT, 'fe-architecture-extras.json'), 'utf8')) } catch {}
let config = null // app config (editable page title) — admin-curated, not pipeline output
try { config = JSON.parse(fs.readFileSync(path.join(AUDIT, 'config.json'), 'utf8')) } catch {}
// Raw inventory-extra so the Admin panel can edit Documentation (and other extras) in read-only
// deploys and download a complete, committable file — the merged inventory alone can't round-trip.
let inventoryExtra = null
try { inventoryExtra = JSON.parse(fs.readFileSync(path.join(AUDIT, 'inventory-extra.json'), 'utf8')) } catch {}
// Raw service-map.json (backlog #16) so the Admin panel's Services tab can edit it in read-only deploys.
let serviceMap = null
try { serviceMap = JSON.parse(fs.readFileSync(path.join(AUDIT, 'service-map.json'), 'utf8')) } catch {}
fs.writeFileSync(path.join(dist, 'data.json'), JSON.stringify({ ...main, extras, config, inventoryExtra, serviceMap }))

fs.rmSync(published, { recursive: true, force: true })
fs.cpSync(dist, published, { recursive: true })
console.log('bundled -> published/')
