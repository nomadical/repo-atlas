import { expect, it } from 'vitest'
import Details from './Details.jsx'
import { act, render } from './renderForTest.js'

it('labels region members without a kind as Other in the breakdown', () => {
  const region = {
    label: 'Shared',
    members: [
      { id: 'a', title: 'A', kind: 'client' },
      { id: 'b', title: 'B' },
    ],
  }
  const container = render(<Details data={{ region }} />)
  const chips = [...container.querySelectorAll('.mod-chip')].map((chip) => chip.textContent)
  expect(chips).toEqual(['Client · 1', 'Other · 1'])
})

function pointer(type, props) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, ...props })
  Object.defineProperty(event, 'pointerId', { value: props.pointerId })
  return event
}

function renderResizer(onResize, width = 360) {
  const region = { label: 'Shared', members: [] }
  const container = render(<Details data={{ region }} width={width} onResize={onResize} />)
  return container.querySelector('[role="separator"]')
}

it('resizes the panel from the keyboard within its bounds', () => {
  const widths = []
  const handle = renderResizer((width) => widths.push(width))
  expect(handle.getAttribute('tabindex')).toBe('0')
  expect(handle.getAttribute('aria-valuenow')).toBe('360')
  act(() => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
  act(() => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  act(() => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
  expect(widths).toEqual([376, 344, 720])
})

it('follows only the pointer that started the drag and stops on pointercancel', () => {
  const widths = []
  const handle = renderResizer((width) => widths.push(width))
  const right = window.innerWidth
  act(() => handle.dispatchEvent(pointer('pointerdown', { pointerId: 1, clientX: right - 360 })))
  act(() => handle.dispatchEvent(pointer('pointermove', { pointerId: 2, clientX: right - 600 })))
  act(() => handle.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: right - 500 })))
  act(() => handle.dispatchEvent(pointer('pointercancel', { pointerId: 1 })))
  act(() => handle.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: right - 400 })))
  expect(widths).toEqual([500])
})
