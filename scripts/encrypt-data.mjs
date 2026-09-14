// Encrypts published/data.json -> published/data.enc for the public GitHub Pages deploy.
//
// Pages has no server, so instead of HTTP basic auth the data itself is encrypted at rest
// (AES-256-GCM, key derived from a shared team passphrase via PBKDF2). The viz detects
// data.enc and shows a passphrase gate that decrypts in the browser (WebCrypto). Without
// the passphrase the public URL serves only ciphertext.
//
// Run after bundle.mjs with ARCHMAP_PASSPHRASE set; deletes the plaintext data.json so a
// misconfigured deploy fails loudly rather than publishing the data unprotected.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { AUDIT } from './_paths.mjs'

const pass = process.env.ARCHMAP_PASSPHRASE
if (!pass || pass.length < 12) {
  console.error('encrypt-data: ARCHMAP_PASSPHRASE missing or shorter than 12 chars — refusing to publish')
  process.exit(1)
}

const dir = path.join(AUDIT, 'published')
const src = path.join(dir, 'data.json')
const plaintext = fs.readFileSync(src)

const salt = crypto.randomBytes(16)
const iv = crypto.randomBytes(12)
// data.enc is world-downloadable (Pages is public), so the KDF cost is the only brake on an
// offline guess-rate: 600k = current OWASP guidance for PBKDF2-SHA256. The viz reads the count
// from the blob (enc.iterations), so bumping it here needs no client change.
const iterations = 600000
const key = crypto.pbkdf2Sync(pass, salt, iterations, 32, 'sha256')
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]) // tag appended -> WebCrypto-compatible

fs.writeFileSync(path.join(dir, 'data.enc'), JSON.stringify({
  v: 1, kdf: 'PBKDF2-SHA256', iterations,
  salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'),
}))
fs.unlinkSync(src)
console.log(`encrypt-data: wrote data.enc (${(ct.length / 1024).toFixed(0)} kB), removed plaintext data.json`)
