import React, { useState } from 'react'

// Full-screen passphrase gate shown when only encrypted data is available. Nothing is decrypted yet
// (not even config.json), so the title has to come from the build.
export default function Gate({
  onUnlock,
  error,
  busy,
  title = import.meta.env.VITE_APP_TITLE || 'Repo Atlas',
}) {
  const [passphrase, setPassphrase] = useState('')

  const submit = (event) => {
    event.preventDefault()
    onUnlock(passphrase)
  }

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <div className="brand gate-brand">
          <span className="brand-mark" />
          {title}
        </div>
        <p className="gate-hint">This map is encrypted. Enter the team passphrase to unlock it.</p>
        <input
          type="password"
          autoFocus
          value={passphrase}
          placeholder="Passphrase"
          onChange={(event) => setPassphrase(event.target.value)}
        />
        <button className="btn primary" type="submit" disabled={busy || !passphrase}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        {error ? <div className="gate-err">Wrong passphrase — try again.</div> : null}
      </form>
    </div>
  )
}
