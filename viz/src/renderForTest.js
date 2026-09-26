// Renders a component into jsdom for tests; unmounts whatever the previous render mounted.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root = null
afterEach(() => {
  if (root) act(() => root.unmount())
  root = null
  document.body.innerHTML = ''
})

export function render(element) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(element))
  return container
}

export { act }
