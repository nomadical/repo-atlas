import { expect, it } from 'vitest'
import { render } from '../renderForTest.js'
import { DetailSwitch } from './Toolbar.jsx'

it('names the Detail switch without relying on its visible label', () => {
  const container = render(<DetailSwitch mode="dev" setMode={() => {}} />)
  expect(container.querySelector('input').getAttribute('aria-label')).toBe('Detail')
})
