import React, { useState } from 'react'

// Full-screen passphrase gate shown when only encrypted data is available. The title is shown
// before any data (and therefore any config.json) has been decrypted, so it comes from the build:
// VITE_APP_TITLE, falling back to the product name.
export default function Gate({ onUnlock, error, busy, title = import.meta.env.VITE_APP_TITLE || 'Repo Atlas' }) {
  const [pass, setPass] = useState('')
  return (
    <div className="gate">
      <form
        className="gate-card"
        onSubmit={(e) => {
          e.preventDefault()
          onUnlock(pass)
        }}
      >
        <div className="brand gate-brand">
          <span className="brand-mark" />
          {title}
        </div>
        <p className="gate-hint">This map is encrypted. Enter the team passphrase to unlock it.</p>
        <input type="password" autoFocus value={pass} placeholder="Passphrase" onChange={(e) => setPass(e.target.value)} />
        <button className="btn primary" type="submit" disabled={busy || !pass}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        {error ? <div className="gate-err">Wrong passphrase — try again.</div> : null}
      </form>
    </div>
  )
}
