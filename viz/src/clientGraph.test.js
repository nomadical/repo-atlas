// Tests for the per-client drill-down graph: screen→endpoint→backend tiers and backend resolution.
import { describe, it, expect } from 'vitest'
import { buildClientGraph, clientBackendResolver, screenBackendLabels, componentAdoption } from './clientGraph.js'

const data = {
  repos: [{ folder: 'app1', apiUrl: 'api.example.com' }],
  backendTopology: { backends: [{ id: 'be1', label: 'Core API', host: 'api.example.com' }] },
  extras: {
    screens: {
      perRepo: {
        app1: {
          method: 'router',
          routerFiles: 1,
          endpointLinks: { orders: 'https://api.example.com/q/swagger-ui/#/Orders' },
          screens: [
            { name: 'Orders', component: 'Orders', path: '/orders', roles: ['ADMIN'], endpoints: ['orders', 'users/{id}'] },
            { name: 'Home', component: 'Home', path: '/', roles: [], endpoints: [] },
          ],
        },
      },
    },
  },
}

describe('buildClientGraph', () => {
  it('returns null for a folder with no screen data', () => {
    expect(buildClientGraph(data, 'nope')).toBe(null)
  })

  it('builds three tiers: screens → endpoints → backend', () => {
    const g = buildClientGraph(data, 'app1')
    const byKind = (k) => g.nodes.filter((n) => n.data.kind === k)
    expect(byKind('screen').length).toBe(2)
    expect(byKind('endpoint').length).toBe(2) // orders + users/{id}, deduped
    expect(byKind('backend').length).toBe(1) // both endpoints resolve to be1
    expect(g).toMatchObject({ screenCount: 2, endpointCount: 2, backendCount: 1 })
  })

  it('wires screen→endpoint and endpoint→backend edges (no dangling)', () => {
    const g = buildClientGraph(data, 'app1')
    const ids = new Set(g.nodes.map((n) => n.id))
    for (const e of g.edges) {
      expect(ids.has(e.source)).toBe(true)
      expect(ids.has(e.target)).toBe(true)
    }
    expect(g.edges.some((e) => e.source.startsWith('screen:') && e.target.startsWith('ep:'))).toBe(true)
    expect(g.edges.some((e) => e.source.startsWith('ep:') && e.target.startsWith('be:'))).toBe(true)
  })

  it('resolves endpoints to a backend by swagger-link host and by repo apiUrl fallback', () => {
    const { backendOf } = clientBackendResolver(data, 'app1')
    expect(backendOf('orders')?.id).toBe('be1') // via swagger link host
    expect(backendOf('users/{id}')?.id).toBe('be1') // no link → repo apiUrl fallback
  })

  it('screenBackendLabels lists distinct backends for a screen', () => {
    const { backendOf } = clientBackendResolver(data, 'app1')
    const orders = data.extras.screens.perRepo.app1.screens[0]
    expect(screenBackendLabels(orders, backendOf)).toEqual(['Core API'])
  })
})

describe('componentAdoption', () => {
  const extras = {
    screens: {
      perRepo: {
        app1: {
          screens: [
            { name: 'A', components: ['DataGridTable', 'CommonButton'] },
            { name: 'B', components: ['CommonButton'] },
          ],
        },
        app2: { screens: [{ name: 'C', components: ['CommonButton'] }] },
      },
    },
  }
  it('inverts per-screen usage into per-component client/screen counts, sorted by reach', () => {
    const rows = componentAdoption(extras)
    const btn = rows.find((r) => r.component === 'CommonButton')
    const grid = rows.find((r) => r.component === 'DataGridTable')
    expect(btn).toMatchObject({ clients: ['app1', 'app2'], screens: 3 }) // 2 clients, 3 screens
    expect(grid).toMatchObject({ clients: ['app1'], screens: 1 })
    expect(rows[0].component).toBe('CommonButton') // widest reach first
  })
  it('returns [] when there is no screen data', () => {
    expect(componentAdoption({})).toEqual([])
  })
})
