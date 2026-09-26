import React, { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { initAuth } from './auth.js'
import './styles.css'

// The only route: ?view=golden-path shows the Golden Path compliance screen instead of the map.
const SHOW_GOLDEN_PATH = new URLSearchParams(location.search).get('view') === 'golden-path'
// Lazy both ways: the map never downloads the compliance screen, which never downloads React Flow.
const GoldenPath = lazy(() => import('./golden-path/GoldenPath.jsx'))

const root = createRoot(document.getElementById('root'))

function renderApp() {
  if (SHOW_GOLDEN_PATH) {
    root.render(
      <Suspense fallback={null}>
        <GoldenPath />
      </Suspense>,
    )
    return
  }
  root.render(<App />)
}

// If Keycloak init itself fails (network/config, not "logged out", which redirects), render anyway:
// the passphrase gate still protects the data, and an auth outage shouldn't hide the whole map.
initAuth()
  .then(renderApp)
  .catch((error) => {
    console.error('auth init failed — rendering open', error)
    renderApp()
  })
