import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'

const VIEWPORT_MARGIN = 8

// Keeps a box of the given size fully inside the viewport, preferring the requested position.
function clampToViewport(position, size, viewportSize) {
  return Math.max(VIEWPORT_MARGIN, Math.min(position, viewportSize - size - VIEWPORT_MARGIN))
}

function MenuEntry({ item, onClose }) {
  if (item.separator) return <div className="ctx-sep" />
  if (item.heading) return <div className="ctx-heading">{item.heading}</div>
  const runAndClose = () => {
    item.onClick?.()
    onClose()
  }
  return (
    <button
      className={'ctx-item' + (item.danger ? ' danger' : '')}
      disabled={item.disabled}
      role="menuitem"
      onClick={runAndClose}
    >
      {item.icon ? <Icon name={item.icon} /> : <span className="ctx-icon-spacer" />}
      <span>{item.label}</span>
    </button>
  )
}

// Right-click menu (admin only), opened at the cursor. Closes on outside click, Esc, scroll, or
// after an action. Items are { label, icon, onClick, disabled, danger }, { heading } or
// { separator: true }; falsy items are skipped so callers can inline conditionals.
export default function ContextMenu({ x, y, items, onClose }) {
  const menuRef = useRef(null)
  const visibleItems = items.filter(Boolean)
  const [position, setPosition] = useState({ left: x, top: y })

  // Measure after render so the menu can shift back into view when it would overflow.
  useEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const { width, height } = menu.getBoundingClientRect()
    setPosition({
      left: clampToViewport(x, width, window.innerWidth),
      top: clampToViewport(y, height, window.innerHeight),
    })
  }, [x, y, visibleItems.length])

  useEffect(() => {
    const onMouseDown = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) onClose()
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  return (
    <div
      className="ctx-menu"
      ref={menuRef}
      style={{ left: position.left, top: position.top }}
      role="menu"
      onContextMenu={(event) => event.preventDefault()}
    >
      {visibleItems.map((item, index) => (
        <MenuEntry key={index} item={item} onClose={onClose} />
      ))}
    </div>
  )
}
