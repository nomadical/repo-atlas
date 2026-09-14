// Tests for the per-screen extraction primitives: route parsing, import mapping (incl. lazy), and
// the shared endpoint/API-call extractors. Run with `node --test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIG = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json'), 'utf8'))
const UI_PKGS = Array.isArray(CONFIG.uiPackages) ? CONFIG.uiPackages : []
import { parseRoutes, importMap, extractUiComponents } from './screens-gather.mjs'
import { extractEndpointsFromText, extractApiCallsFromText, normalizeEndpoint } from './lib/endpoints.mjs'

test('parseRoutes: RouteItem[] array entries (element + path + roles)', () => {
  const src = `
    return [
      { element: <Navigate to="/x" />, path: '/' },
      { element: <Assets />, necessaryRoles: [userRoles.ASSET_MANAGEMENT], path: '/assets' },
      { element: <Loggers />, path: '/loggers', sufficientRoles: [userRoles.LOGGER, userRoles.ASSET] },
    ]`
  const routes = parseRoutes(src)
  const byComp = Object.fromEntries(routes.map((r) => [r.component, r]))
  assert.ok(!byComp.Navigate, 'Navigate redirects are skipped')
  assert.equal(byComp.Assets.path, '/assets')
  assert.deepEqual(byComp.Assets.roles, ['ASSET_MANAGEMENT'])
  assert.equal(byComp.Loggers.path, '/loggers')
  assert.deepEqual(byComp.Loggers.roles, ['LOGGER', 'ASSET'])
})

test('parseRoutes: <Route> JSX (element-first and path-first)', () => {
  const src = `
    <Routes>
      <Route element={<Storybook />} path="/storybook/*" />
      <Route path="/guest" element={<GuestShipmentContainer />} />
    </Routes>`
  const byComp = Object.fromEntries(parseRoutes(src).map((r) => [r.component, r]))
  assert.equal(byComp.Storybook.path, '/storybook/*')
  assert.equal(byComp.GuestShipmentContainer.path, '/guest')
})

test('parseRoutes: createBrowserRouter object routes; skips Outlet wrappers', () => {
  const src = `
    const routes = [
      { path: '/', element: <Root />, children: [
        { path: 'apps', element: <Outlet />, children: X },
        { path: 'apps/dashboard', element: <Dashboard /> },
      ] },
    ]`
  const comps = parseRoutes(src).map((r) => r.component)
  assert.ok(comps.includes('Root'))
  assert.ok(comps.includes('Dashboard'))
  assert.ok(!comps.includes('Outlet'))
})

test('importMap: default, named (with alias), and lazy dynamic imports', () => {
  const src = `
    import Loggers from './Loggers'
    import { Assets, Foo as Bar } from 'AssetManagement/Assets'
    const Shipments = lazy(() => import('./Shipments/Shipments'))
    const AddShipment = React.lazy(() => import('./tabs/AddShipment'))`
  const m = importMap(src)
  assert.equal(m.Loggers, './Loggers')
  assert.equal(m.Assets, 'AssetManagement/Assets')
  assert.equal(m.Bar, 'AssetManagement/Assets') // aliased name
  assert.equal(m.Shipments, './Shipments/Shipments') // lazy
  assert.equal(m.AddShipment, './tabs/AddShipment') // React.lazy
})

test('extractEndpointsFromText: use*Endpoints hooks (quotes + interpolation)', () => {
  const src = "useBackendEndpoints('admin/companies'); useFooEndpoints(`companies/${id}/settings`); useBarEndpoints(\"assets\")"
  const eps = [...extractEndpointsFromText(src)].sort()
  assert.deepEqual(eps, ['admin/companies', 'assets', 'companies/{id}/settings'])
})

test('extractApiCallsFromText: axios/fetch/method + template URLs; strips host/version', () => {
  const src = [
    "axios.post(`${SKYGATE_URL}gateway/000002/installation-confirmation?x=1`)",
    "client.get('/gateways')",
    "fetch('users/preferences')",
    "http.get('https://api.meridian.example/v1')", // bare version → dropped
  ].join('\n')
  const eps = [...extractApiCallsFromText(src)].sort()
  assert.ok(eps.includes('gateway/000002/installation-confirmation'), 'template URL path, query stripped')
  assert.ok(eps.includes('gateways'), 'method-call literal, leading slash trimmed')
  assert.ok(eps.includes('users/preferences'))
  assert.ok(!eps.includes('v1'), 'bare version prefix filtered out')
})

// The design-system package list is config.json `uiPackages`, so this drives the parser with
// whatever is configured — and skips when nothing is, since then there is no import to recognise.
test('extractUiComponents: named imports from a configured UI package, by export name', { skip: UI_PKGS.length ? false : 'no uiPackages configured' }, () => {
  const pkg = UI_PKGS[0]
  const src = `
    import { Card, DataTable } from '${pkg}'
    import { PageHeader as Header, TOOLTIP_TYPE } from '${pkg}'
    import { Unrelated } from 'some-other-pkg'`
  const comps = [...extractUiComponents(src)].sort()
  assert.ok(comps.includes('Card') && comps.includes('DataTable'))
  assert.ok(comps.includes('PageHeader'), 'uses the exported name, not the local alias') // `as Header`
  assert.ok(!comps.includes('Unrelated'), 'non-ui packages are ignored')
})

test('extractUiComponents: every configured package name is recognised', { skip: UI_PKGS.length < 2 ? 'only one uiPackage configured' : false }, () => {
  // A package mid-rename is pinned under both names across the estate; both must collapse onto the
  // one hub, or the consumers still on the old name silently drop off it.
  for (const pkg of UI_PKGS) {
    assert.ok([...extractUiComponents(`import { Thing } from '${pkg}'`)].includes('Thing'), pkg)
  }
})

test('normalizeEndpoint: interpolation → {id}, slashes trimmed', () => {
  assert.equal(normalizeEndpoint('/companies/${id}/settings/'), 'companies/{id}/settings')
  assert.equal(normalizeEndpoint('${cond ? a : b}/x'), 'x') // conditional fragment dropped
})
