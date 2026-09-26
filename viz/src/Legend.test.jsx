import { afterEach, expect, it } from 'vitest'
import { Legend } from './Legend.jsx'
import { act, render } from './renderForTest.js'

afterEach(() => localStorage.clear())

const renderLegend = () => render(<Legend kinds={new Set(['service'])} edgeTypesPresent={[]} />)

it('starts collapsed so the key does not cover the map', () => {
  const container = renderLegend()
  expect(container.querySelector('.legend-toggle').getAttribute('aria-expanded')).toBe('false')
  expect(container.querySelector('.legend-item')).toBe(null)
})

it('remembers that the viewer opened it', () => {
  let container = renderLegend()
  act(() => container.querySelector('.legend-toggle').click())
  expect(container.querySelector('.legend-item')).not.toBe(null)
  container = renderLegend()
  expect(container.querySelector('.legend-toggle').getAttribute('aria-expanded')).toBe('true')
})
