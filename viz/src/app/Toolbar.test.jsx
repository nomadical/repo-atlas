import { expect, it } from 'vitest'
import { render } from '../renderForTest.js'
import { DetailSwitch, SearchBox } from './Toolbar.jsx'

const renderSearch = (view) =>
  render(
    <SearchBox view={view} query="" setQuery={() => {}} searchList={[]} matchIdx={0} stepMatch={() => {}} />,
  ).querySelector('input')

it('names the search box for what it does in the current view', () => {
  expect(renderSearch('graph').getAttribute('aria-label')).toBe('Search repos')
  expect(renderSearch('table').getAttribute('aria-label')).toBe('Filter inventory')
  expect(renderSearch('table').placeholder).toBe('Filter inventory…')
  expect(renderSearch('integrations').getAttribute('aria-label')).toBe('Filter integrations')
})

it('names the Detail switch without relying on its visible label', () => {
  const container = render(<DetailSwitch mode="dev" setMode={() => {}} />)
  expect(container.querySelector('input').getAttribute('aria-label')).toBe('Detail')
})
