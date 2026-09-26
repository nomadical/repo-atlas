import { expect, it, vi } from 'vitest'
import { act, render } from '../renderForTest.js'
import { DetailSwitch, MoreMenu, SearchBox } from './Toolbar.jsx'

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

it('keeps Export, Regenerate and Publish reachable from the actions menu', () => {
  const post = vi.fn()
  const exportPng = vi.fn()
  const container = render(
    <MoreMenu
      busy={null}
      exportPng={exportPng}
      downloadData={() => {}}
      openEmbed={() => {}}
      showPipelineActions
      post={post}
    />,
  )
  const openMenu = () => act(() => container.querySelector('.dd-btn').click())
  const item = (label) =>
    [...container.querySelectorAll('.dd-item')].find((button) => button.textContent === label)
  openMenu()
  expect(container.querySelector('.dd-btn').getAttribute('title')).toBe('More actions')
  act(() => item('Export PNG').click())
  openMenu()
  act(() => item('Publish diagram').click())
  expect(exportPng).toHaveBeenCalledOnce()
  expect(post).toHaveBeenCalledWith('/api/publish', 'Publish')
})
