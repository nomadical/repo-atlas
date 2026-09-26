// Encrypts published/data.json -> published/data.enc for the public GitHub Pages deploy.
//
// Pages has no server, so the data itself is encrypted at rest (AES-256-GCM, key derived from a
// shared team passphrase via PBKDF2) and the viz decrypts it in the browser (WebCrypto).
//
// Run after bundle.mjs with ARCHMAP_PASSPHRASE set. The plaintext data.json is deleted, so a
// misconfigured deploy fails loudly instead of publishing unprotected data.
//
// Publishing openly (a demo, a public-by-design map) must be a decision, not a forgotten secret,
// so it needs PAGES_PUBLIC_DATA=1. With neither, this refuses: a wrong guess can't be undone.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { AUDIT } from './_paths.mjs'

const MIN_PASSPHRASE_LENGTH = 12
const SALT_BYTES = 16
// 96-bit IV, the GCM standard.
const IV_BYTES = 12
const KEY_BYTES = 32
// data.enc is world-downloadable, so the KDF cost is the only brake on offline guessing; 600k is
// the OWASP guidance for PBKDF2-SHA256. The viz reads the count from the blob, so raising it here
// needs no client change.
const PBKDF2_ITERATIONS = 600000

const passphrase = process.env.ARCHMAP_PASSPHRASE
const publishUnencrypted = process.env.PAGES_PUBLIC_DATA === '1'

if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
  if (!publishUnencrypted) {
    console.error(
      'encrypt-data: refusing to publish.\n' +
        '  GitHub Pages is public, so the data needs either a passphrase or your explicit consent to go out in the clear.\n' +
        '  Pick one:\n' +
        '    • Protect it — set the ARCHMAP_PASSPHRASE repo SECRET (12+ chars). Readers type it once; the data is\n' +
        '      decrypted in their browser and never served in plaintext.\n' +
        '    • Publish it openly — set the PAGES_PUBLIC_DATA repo VARIABLE to 1. Right for a demo or a map you\n' +
        '      intend to be world-readable; wrong for a real internal estate.\n' +
        '  For real protection (no shared passphrase at all), serve the data from server/server.mjs instead — see infra/hosting.md.',
    )
    process.exit(1)
  }
  console.log(
    'encrypt-data: PAGES_PUBLIC_DATA=1 — publishing data.json UNENCRYPTED and world-readable, by explicit configuration.',
  )
  process.exit(0)
}

const publishedDir = path.join(AUDIT, 'published')
const plaintextPath = path.join(publishedDir, 'data.json')
const plaintext = fs.readFileSync(plaintextPath)

const salt = crypto.randomBytes(SALT_BYTES)
const iv = crypto.randomBytes(IV_BYTES)
const key = crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_BYTES, 'sha256')
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
// The auth tag goes at the end, which is where WebCrypto expects it.
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])

fs.writeFileSync(
  path.join(publishedDir, 'data.enc'),
  JSON.stringify({
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ct: ciphertext.toString('base64'),
  }),
)
fs.unlinkSync(plaintextPath)
const sizeKb = (ciphertext.length / 1024).toFixed(0)
console.log(`encrypt-data: wrote data.enc (${sizeKb} kB), removed plaintext data.json`)
