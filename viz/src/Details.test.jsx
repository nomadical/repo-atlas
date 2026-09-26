import { expect, it } from 'vitest'
import Details from './Details.jsx'
import { render } from './renderForTest.js'

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
