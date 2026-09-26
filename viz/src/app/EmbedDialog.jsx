import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../icons.jsx'
import { embedUrl } from './urlState.js'

// Plain numbers get a px unit; "100%" and other CSS values pass through.
function cssSize(value) {
  const trimmed = String(value).trim()
  if (/^\d+$/.test(trimmed)) return trimmed + 'px'
  return trimmed || 'auto'
}

function iframeSnippet(src, title, width, height) {
  return `<iframe src="${src}" title="${title}" width="${cssSize(width)}" height="${cssSize(height)}" loading="lazy" style="border:0;border-radius:12px;max-width:100%"></iframe>`
}

// Turns the current filtered view into a copy-pasteable <iframe> snippet with a live preview. The
// URL already mirrors every filter, view and selection, so the snippet is just that URL + embed=1.
export default function EmbedDialog({ onClose, onCopied, title }) {
  const [width, setWidth] = useState('100%')
  const [height, setHeight] = useState('640')
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])
  const src = useMemo(() => embedUrl(), [])
  const snippet = iframeSnippet(src, title, width, height)
  const copy = () => {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(snippet).then(() => onCopied?.())
    else onCopied?.()
  }
  return (
    <div
      className="legend-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Embed this view"
    >
      <div className="legend-card embed-card" onClick={(e) => e.stopPropagation()}>
        <div className="legend-head">
          <h3>Embed this view</h3>
          <button className="btn ghost" onClick={onClose} aria-label="Close embed dialog">
            <Icon name="close" />
          </button>
        </div>
        <p className="embed-hint">
          The embed shows <b>exactly the current filters, view &amp; selection</b>. Adjust the filters first
          to frame a specific part of the map, then copy the snippet below into your wiki's HTML/iframe macro
          or any web page.
        </p>
        <div className="embed-dims">
          <label>
            Width
            <input value={width} onChange={(e) => setWidth(e.target.value)} placeholder="100%" />
          </label>
          <label>
            Height
            <input value={height} onChange={(e) => setHeight(e.target.value)} placeholder="640" />
          </label>
          <span className="embed-dims-note">Plain numbers are pixels; use 100% to fill the container.</span>
        </div>
        <textarea
          className="embed-code"
          readOnly
          value={snippet}
          rows={3}
          onFocus={(e) => e.target.select()}
        />
        <div className="embed-actions">
          <a
            className="btn ghost"
            href={src}
            target="_blank"
            rel="noreferrer"
            title="Open the embeddable view in a new tab"
          >
            <Icon name="external" /> Preview
          </a>
          <button className="btn primary" onClick={copy}>
            <Icon name="code" /> Copy embed code
          </button>
        </div>
        <div className="embed-preview-wrap">
          <div className="embed-preview-cap">Live preview</div>
          <iframe className="embed-preview" src={src} title="Embed preview" loading="lazy" />
        </div>
      </div>
    </div>
  )
}
