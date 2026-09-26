import React, { useEffect, useRef } from 'react'
import css from './page.css?inline'
import { mountPage } from './page.js'

/* Renders into a shadow root because the screen's class names (.chip, .panel, .seg) are ones the
   app's stylesheet also uses; the boundary keeps both apart. The theme attribute sits on the host,
   so this screen's light/dark switch does not touch the app's. */
export default function GoldenPath() {
  const hostRef = useRef(null)
  useEffect(() => {
    const host = hostRef.current
    // StrictMode mounts effects twice in dev; reuse the root rather than throwing on the second run.
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = css
    // One sheet first; mountPage appends the page's own markup after it.
    root.replaceChildren(style)
    return mountPage(host, root)
  }, [])
  return <div ref={hostRef} />
}
