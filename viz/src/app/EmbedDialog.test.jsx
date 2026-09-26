import { expect, it } from 'vitest'
import EmbedDialog from './EmbedDialog.jsx'
import { act, render } from '../renderForTest.js'

function typeInto(input, value) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
  act(() => input.dispatchEvent(new Event('input', { bubbles: true })))
}

it('trims a plain number before adding the px unit', () => {
  const container = render(<EmbedDialog title="Map" onClose={() => {}} />)
  const [width, height] = container.querySelectorAll('.embed-dims input')
  typeInto(width, ' 800 ')
  typeInto(height, ' 640')
  const snippet = container.querySelector('.embed-code').value
  expect(snippet).toContain('width="800px"')
  expect(snippet).toContain('height="640px"')
})
