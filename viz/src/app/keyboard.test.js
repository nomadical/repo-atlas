import { expect, it } from 'vitest'
import { activatedNodeId } from './keyboard.js'

function nodeElement(id) {
  const element = document.createElement('div')
  element.className = 'react-flow__node react-flow__node-card'
  element.dataset.id = id
  return element
}

it('activates the focused node on Enter and Space', () => {
  const target = nodeElement('svc-orders')
  expect(activatedNodeId({ key: 'Enter', target })).toBe('svc-orders')
  expect(activatedNodeId({ key: ' ', target })).toBe('svc-orders')
})

it('ignores other keys and presses inside a node', () => {
  const node = nodeElement('svc-orders')
  const button = document.createElement('button')
  node.appendChild(button)
  expect(activatedNodeId({ key: 'a', target: node })).toBe(null)
  expect(activatedNodeId({ key: 'Enter', target: button })).toBe(null)
})
