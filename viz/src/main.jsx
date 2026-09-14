import React, { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { initAuth } from './auth.js'
import './styles.css'

// The one route: ?view=golden-path swaps the map for the Golden Path compliance screen (its own app
// bar links back). Everything else about that screen lives under src/golden-path/.
const GOLDEN_PATH = new URLSearchParams(location.search).get('view') === 'golden-path'
// Code-split both ways, as the app does for its off-the-default-path views: the map never downloads
// the compliance screen, and the compliance screen never downloads React Flow.
const GoldenPath = lazy(() => import('./golden-path/GoldenPath.jsx'))

const root = createRoot(document.getElementById('root'))
const render = () =>
  root.render(
    GOLDEN_PATH ? (
      <Suspense fallback={null}>
        <GoldenPath />
      </Suspense>
    ) : (
      <App />
    ),
  )

// Gate on a Keycloak (Microsoft) session before mounting when auth is configured. If Keycloak
// init itself fails (network/config — distinct from "not logged in", which redirects away), fail
// open to the app: the data stays protected by the passphrase gate, so a transient auth outage
// shouldn't hide the whole map.
initAuth()
  .then(render)
  .catch((err) => {
    console.error('auth init failed — rendering open', err)
    render()
  })
