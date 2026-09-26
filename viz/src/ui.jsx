import React, { useState, useEffect, useId } from 'react'
import { Icon } from './icons.jsx'

const ABSOLUTE_URL = /^https?:\/\//i

// Toolbar dropdown that closes on outside click or Escape. `children` may be a function that gets
// close(), so menu items can dismiss the menu on selection. It is a disclosure (aria-expanded +
// aria-controls), not an ARIA menu: panels mix checkboxes, inputs and buttons, and there is no
// arrow-key roving focus that role="menu" would promise.
export function Dropdown({ label, badge, caret = true, align = 'left', className, title, children }) {
  const [open, setOpen] = useState(false)
  const containerRef = React.useRef(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const close = () => setOpen(false)

  return (
    <div className={'dd' + (className ? ' ' + className : '')} ref={containerRef}>
      <button
        className={'btn dd-btn' + (open ? ' on' : '')}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        title={title}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        {label}
        {badge ? <span className="dd-badge">{badge}</span> : null}
        {caret ? (
          <span className="dd-caret">
            <Icon name="caretDown" />
          </span>
        ) : null}
      </button>
      {open ? (
        <div id={panelId} className={'dd-menu' + (align === 'right' ? ' right' : '')}>
          {typeof children === 'function' ? children(close) : children}
        </div>
      ) : null}
    </div>
  )
}

export const FilterRow = ({ checked, onChange, children }) => (
  <label className="dd-item">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    {children}
  </label>
)

export const Section = ({ title, children }) => (
  <div className="sec">
    <h3>{title}</h3>
    {children}
  </div>
)

// Resolves inventory Documentation to a link, or null. `doc` is the human label, `docUrl` an
// explicit link. An explicit URL (in either field) wins; a bare label goes to the docs search
// (config.docSearchUrl, the query is appended url-encoded). Without a search URL a bare label
// isn't linked.
export const DEFAULT_DOC_SEARCH = ''
export const docHref = (doc, docUrl, searchBase = DEFAULT_DOC_SEARCH) => {
  if (docUrl && ABSOLUTE_URL.test(docUrl)) return docUrl
  if (!doc) return null
  if (ABSOLUTE_URL.test(doc)) return doc
  return searchBase ? searchBase + encodeURIComponent(doc) : null
}

export const KV = ({ k, v }) => {
  if (v == null || v === '') return null
  return (
    <div className="kv">
      <span>{k}</span>
      <b>{String(v)}</b>
    </div>
  )
}

// Colours live in styles.css (--st-* tokens); an unknown status gets the neutral Removed grey.
const STATUS_CLASS = {
  Current: 'st-current',
  Planned: 'st-planned',
  Sunsetting: 'st-sunsetting',
  Removed: 'st-removed',
}

export function StatusChip({ status }) {
  if (!status) return null
  return <span className={'status-chip ' + (STATUS_CLASS[status] || '')}>{status}</span>
}
