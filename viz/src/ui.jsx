import React, { useState, useEffect } from 'react'
import { Icon } from './icons.jsx'

// Toolbar dropdown: closes on outside click / Escape; children may be a function
// receiving close() so menu items can dismiss the menu on selection.
export function Dropdown({ label, badge, caret = true, align = 'left', className, title, children }) {
  const [open, setOpen] = useState(false)
  const ref = React.useRef(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className={'dd' + (className ? ' ' + className : '')} ref={ref}>
      <button className={'btn dd-btn' + (open ? ' on' : '')} onClick={() => setOpen((o) => !o)} title={title} aria-haspopup="menu" aria-expanded={open}>
        {label}
        {badge ? <span className="dd-badge">{badge}</span> : null}
        {caret ? (
          <span className="dd-caret">
            <Icon name="caretDown" />
          </span>
        ) : null}
      </button>
      {open ? (
        <div className={'dd-menu' + (align === 'right' ? ' right' : '')}>{typeof children === 'function' ? children(() => setOpen(false)) : children}</div>
      ) : null}
    </div>
  )
}

export const FilterRow = ({ checked, onChange, children }) => (
  <label className="dd-item">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    {children}
  </label>
)

export const Section = ({ title, children }) => (
  <div className="sec">
    <h3>{title}</h3>
    {children}
  </div>
)

// Resolve inventory Documentation to a link. `doc` is the human label; `docUrl` is the explicit
// link. Precedence: an explicit docUrl (or a doc that is itself a URL) links straight through; a
// bare label falls back to a docs quick-search — set config.docSearchUrl to your wiki's search URL
// (the query is appended url-encoded), e.g. 'https://wiki.example.com/search?text='. Unset, a bare
// label just isn't a link. Returns null when there's nothing to link. Shared by Details + the table.
export const DEFAULT_DOC_SEARCH = ''
export const docHref = (doc, docUrl, searchBase = DEFAULT_DOC_SEARCH) => {
  if (docUrl && /^https?:\/\//i.test(docUrl)) return docUrl
  if (!doc) return null
  if (/^https?:\/\//i.test(doc)) return doc
  return searchBase ? searchBase + encodeURIComponent(doc) : null
}
export const KV = ({ k, v }) =>
  v == null || v === '' ? null : (
    <div className="kv">
      <span>{k}</span>
      <b>{String(v)}</b>
    </div>
  )

const STATUS_CLR = { Current: '#1e8e3e', Planned: '#1a73e8', Sunsetting: '#e8830c', Removed: '#9aa3b5' }
export function StatusChip({ status }) {
  if (!status) return null
  return (
    <span className="status-chip" style={{ background: STATUS_CLR[status] || '#888' }}>
      {status}
    </span>
  )
}
