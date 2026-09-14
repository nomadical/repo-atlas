import React, { useEffect, useRef } from 'react'
import css from './page.css?inline'
import { mountPage } from './page.js'

/* The screen's only export. It renders into a shadow root because its class names (.chip, .panel,
   .seg) are ones the app's stylesheet also uses; the boundary settles that in both directions
   instead of a renaming exercise that has to stay correct forever. The theme attribute sits on the
   host, so this screen's light/dark switch does not touch the app's. */
export default function GoldenPath() {
  const box = useRef(null)
  useEffect(() => {
    const host = box.current
    // StrictMode mounts effects twice in dev; reuse the root rather than throwing on the second run.
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = css
    root.replaceChildren(style) // one sheet, then the page's own markup after it
    return mountPage(host, root)
  }, [])
  return <div ref={box} />
}
