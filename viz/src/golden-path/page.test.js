// Keyboard, touch and screen-reader behaviour of the golden-path screen, mounted in jsdom over the
// committed history and rules.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import history from '../../../golden-path/history.json'
import rules from '../../../golden-path/rules.json'
import { mountPage } from './page.js'
const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => structuredClone(body),
})

function fakeFetch(url) {
  const path = String(url)
  if (path.endsWith('/golden-path/history')) return jsonResponse(history)
  if (path.endsWith('/golden-path/rules')) return jsonResponse(rules)
  if (path.endsWith('/api/exceptions')) return jsonResponse({ entries: [], mayCurate: false })
  throw new Error(`unexpected fetch ${path}`)
}

let root
let teardown

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const $ = (selector) => root.querySelector(selector)
const $$ = (selector) => [...root.querySelectorAll(selector)]
const press = (target, key) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }))

beforeEach(async () => {
  globalThis.fetch = vi.fn(async (url) => fakeFetch(url))
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  Element.prototype.scrollIntoView = () => {}
  globalThis.CSS ??= {}
  globalThis.CSS.escape ??= (text) => String(text).replace(/["\\]/g, '\\$&')
  window.history.replaceState(null, '', '/?view=golden-path')
  const host = document.createElement('div')
  document.body.append(host)
  root = host.attachShadow({ mode: 'open' })
  teardown = mountPage(host, root)
  await settle()
})

afterEach(() => {
  teardown()
  document.body.innerHTML = ''
})

it('renders one row per repository', () => {
  expect($$('tbody tr[data-repo]').length).toBeGreaterThan(0)
})

it('operates the Type filter with real checkboxes and closes it with Escape', () => {
  const trigger = $('#ms-type .ms-btn')
  trigger.click()
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  const first = $('#ms-type .ms-opt input')
  const value = first.value
  first.click()
  const fresh = $$('#ms-type .ms-opt input').find((input) => input.value === value)
  expect(fresh.checked).toBe(true)
  expect(root.activeElement).toBe(fresh)
  expect($('#ms-type').classList.contains('open')).toBe(true)
  for (const row of $$('tbody tr[data-repo] .kind')) expect(row.textContent).toBe(value)
  press(fresh, 'Escape')
  expect($('#ms-type').classList.contains('open')).toBe(false)
  expect($('#ms-type .ms-btn').getAttribute('aria-expanded')).toBe('false')
  expect(root.activeElement).toBe($('#ms-type .ms-btn'))
})

it('resets aria-expanded when an outside click closes a dropdown', () => {
  $('#ms-owner .ms-btn').click()
  document.body.click()
  expect($('#ms-owner .ms-btn').getAttribute('aria-expanded')).toBe('false')
})

it('opens a component from the button in its name cell and keeps rows as table rows', () => {
  const rows = $$('tbody tr[data-repo]')
  expect(rows.every((row) => !row.hasAttribute('role') && !row.hasAttribute('tabindex'))).toBe(true)
  const button = rows[0].querySelector('button.nm')
  button.focus()
  button.click()
  expect($('#drawer').classList.contains('open')).toBe(true)
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(rows[0].classList.contains('open')).toBe(true)
  press(document.body, 'j')
  expect($('#d-name').textContent).toBe(rows[1].dataset.repo)
  press(document.body, 'ArrowUp')
  expect($('#d-name').textContent).toBe(rows[0].dataset.repo)
  press(document.body, 'Escape')
  expect($('#drawer').classList.contains('open')).toBe(false)
  expect(root.activeElement).toBe(rows[0].querySelector('button.nm'))
  expect(button.getAttribute('aria-expanded')).toBe('false')
})

it('still opens a component from a mouse click anywhere on the row', () => {
  const row = $$('tbody tr[data-repo]')[2]
  row.querySelector('td:last-child').click()
  expect($('#d-name').textContent).toBe(row.dataset.repo)
})

it('moves between tabs with arrow keys, Home and End, with one tab stop', () => {
  const [compliance, analytics] = $$('#tabs [role="tab"]')
  expect([compliance.tabIndex, analytics.tabIndex]).toEqual([0, -1])
  expect(root.getElementById(compliance.getAttribute('aria-controls')).getAttribute('role')).toBe('tabpanel')
  expect(root.getElementById(analytics.getAttribute('aria-controls')).getAttribute('role')).toBe('tabpanel')
  compliance.focus()
  press(compliance, 'ArrowRight')
  expect(root.activeElement).toBe(analytics)
  expect(analytics.getAttribute('aria-selected')).toBe('true')
  expect([compliance.tabIndex, analytics.tabIndex]).toEqual([-1, 0])
  expect($('#analytics').hidden).toBe(false)
  expect($('#view-table').hidden).toBe(true)
  press(analytics, 'ArrowRight')
  expect(root.activeElement).toBe(compliance)
  press(compliance, 'End')
  expect(root.activeElement).toBe(analytics)
  press(analytics, 'Home')
  expect(compliance.getAttribute('aria-selected')).toBe('true')
  expect($('#view-table').hidden).toBe(false)
})

it('lets keyboard readers step through the trend chart', () => {
  $('#tab-analytics').click()
  const hit = $('#hit')
  expect(hit.getAttribute('role')).toBe('slider')
  expect(hit.getAttribute('tabindex')).toBe('0')
  const last = Number(hit.getAttribute('aria-valuemax'))
  expect(Number(hit.getAttribute('aria-valuenow'))).toBe(last)
  hit.focus()
  expect($('#tip').classList.contains('on')).toBe(true)
  press(hit, 'Home')
  expect(hit.getAttribute('aria-valuenow')).toBe('0')
  expect(hit.getAttribute('aria-valuetext')).toMatch(/Conforming \d+.*applicable checks/)
  press(hit, 'ArrowLeft')
  expect(hit.getAttribute('aria-valuenow')).toBe('0')
  press(hit, 'End')
  expect(hit.getAttribute('aria-valuenow')).toBe(String(last))
  hit.blur()
  expect($('#tip').classList.contains('on')).toBe(false)
})

it('shows the trend readout for a touch tap and keeps it after the finger lifts', () => {
  $('#tab-analytics').click()
  const hit = $('#hit')
  const pointer = (type, pointerType) => {
    const event = new MouseEvent(type, { clientX: 10, bubbles: true })
    Object.defineProperty(event, 'pointerType', { value: pointerType })
    hit.dispatchEvent(event)
  }
  pointer('pointerdown', 'touch')
  expect($('#tip').classList.contains('on')).toBe(true)
  pointer('pointerleave', 'touch')
  expect($('#tip').classList.contains('on')).toBe(true)
  pointer('pointercancel', 'touch')
  expect($('#tip').classList.contains('on')).toBe(false)
  pointer('pointermove', 'mouse')
  pointer('pointerleave', 'mouse')
  expect($('#tip').classList.contains('on')).toBe(false)
})
