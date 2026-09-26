import { expect, it } from 'vitest'
import ClientDetailView from './ClientDetailView.jsx'
import { act, render } from './renderForTest.js'

const data = {
  repos: [{ folder: 'shop' }],
  extras: {
    screens: {
      perRepo: {
        shop: {
          screens: [
            { name: 'Home', path: '/', endpoints: ['/api/a'] },
            { name: 'Cart', path: '/cart', endpoints: [] },
          ],
        },
      },
    },
  },
}

it('keeps the sortable header cells mounted when the sort changes', () => {
  const container = render(<ClientDetailView data={data} folder="shop" title="Shop" onBack={() => {}} />)
  const routeHeader = container.querySelectorAll('th.sortable')[1]
  act(() => routeHeader.click())
  expect(routeHeader.isConnected).toBe(true)
  expect(routeHeader.textContent).toBe('Route ▲')
})
