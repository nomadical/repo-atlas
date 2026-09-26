import { ReactFlowProvider } from '@xyflow/react'
import { expect, it } from 'vitest'
import CardNode from './CardNode.jsx'
import { render } from './renderForTest.js'

const renderCard = (data) =>
  render(
    <ReactFlowProvider>
      <CardNode data={{ kind: 'service', title: 'Orders', ...data }} />
    </ReactFlowProvider>,
  )

it('counts a single integration in the singular', () => {
  const container = renderCard({ repo: { externals: [{ name: 'Stripe' }] } })
  expect(container.querySelector('.node-ext').textContent.trim()).toBe('1 integration')
})

it('counts several integrations in the plural', () => {
  const container = renderCard({ repo: { externals: [{ name: 'Stripe' }, { name: 'SAP' }] } })
  expect(container.querySelector('.node-ext').textContent.trim()).toBe('2 integrations')
})
