import { expect, it } from 'vitest'
import AdminPanel from './AdminPanel.jsx'
import { act, render } from './renderForTest.js'

const tabButton = (container, label) =>
  [...container.querySelectorAll('.adm-tab')].find((button) => button.textContent.startsWith(label))

it('keeps the tab button, and so its focus, when switching tabs', () => {
  const data = { config: {}, backendTopology: {}, integrations: [], repos: [], inventory: [] }
  const container = render(<AdminPanel data={data} layout={{}} onClose={() => {}} onResetLayout={() => {}} />)
  const wiring = tabButton(container, 'FE→BE')
  wiring.focus()
  act(() => wiring.click())
  expect(wiring.isConnected).toBe(true)
  expect(document.activeElement).toBe(wiring)
  expect(wiring.className).toContain('on')
})
