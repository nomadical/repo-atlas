import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'

// Right-click context menu (admin only). Positioned at the cursor and clamped to the viewport.
// Closes on outside-click, Esc, scroll, or after an action runs. `items` is a flat list; entries
// are { label, icon, onClick, disabled, danger } or { separator: true } for a divider. Falsy items
// are skipped so callers can inline conditionals.
export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null)
  const list = items.filter(Boolean)
  // measure so we can flip the menu up/left when it would overflow the viewport
  const [pos, setPos] = useState({ left: x, top: y })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    })
  }, [x, y, list.length])
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])
  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.left, top: pos.top }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {list.map((it, i) =>
        it.separator ? (
          <div key={i} className="ctx-sep" />
        ) : it.heading ? (
          <div key={i} className="ctx-heading">
            {it.heading}
          </div>
        ) : (
          <button
            key={i}
            className={'ctx-item' + (it.danger ? ' danger' : '')}
            disabled={it.disabled}
            role="menuitem"
            onClick={() => {
              it.onClick?.()
              onClose()
            }}
          >
            {it.icon ? <Icon name={it.icon} /> : <span className="ctx-icon-spacer" />}
            <span>{it.label}</span>
          </button>
        ),
      )}
    </div>
  )
}
