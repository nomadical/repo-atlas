import { expect, it } from 'vitest'
import { IntegrationsTable } from './InventoryViews.jsx'
import { render } from './renderForTest.js'

it('links only endpoints that are in the inventory, not inherited object keys', () => {
  const integrations = [
    { source: 'orders', target: 'constructor' },
    { source: '__proto__', target: 'orders' },
  ]
  const inventory = [{ name: 'Orders' }]
  const container = render(
    <IntegrationsTable integrations={integrations} inventory={inventory} query="" onSelect={() => {}} />,
  )
  const links = [...container.querySelectorAll('button.linklike')].map((button) => button.textContent)
  expect(links).toEqual(['orders', 'orders'])
})
