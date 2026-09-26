// Tests for the per-screen extraction primitives: route parsing, import mapping (incl. lazy), and
// the shared endpoint/API-call extractors. Run with `node --test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseRoutes, importMap, extractUiComponents, readTsPaths } from './screens-gather.mjs'
import { extractEndpointsFromText, extractApiCallsFromText, normalizeEndpoint } from './lib/endpoints.mjs'

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json')
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
const UI_PACKAGES = Array.isArray(CONFIG.uiPackages) ? CONFIG.uiPackages : []

const routesByComponent = (source) =>
  Object.fromEntries(parseRoutes(source).map((route) => [route.component, route]))

test('parseRoutes: RouteItem[] array entries (element + path + roles)', () => {
  const src = `
    return [
      { element: <Navigate to="/x" />, path: '/' },
      { element: <Assets />, necessaryRoles: [userRoles.ASSET_MANAGEMENT], path: '/assets' },
      { element: <Loggers />, path: '/loggers', sufficientRoles: [userRoles.LOGGER, userRoles.ASSET] },
    ]`
  const byComponent = routesByComponent(src)
  assert.ok(!byComponent.Navigate, 'Navigate redirects are skipped')
  assert.equal(byComponent.Assets.path, '/assets')
  assert.deepEqual(byComponent.Assets.roles, ['ASSET_MANAGEMENT'])
  assert.equal(byComponent.Loggers.path, '/loggers')
  assert.deepEqual(byComponent.Loggers.roles, ['LOGGER', 'ASSET'])
})

test('parseRoutes: <Route> JSX (element-first and path-first)', () => {
  const src = `
    <Routes>
      <Route element={<Storybook />} path="/storybook/*" />
      <Route path="/guest" element={<GuestShipmentContainer />} />
    </Routes>`
  const byComponent = routesByComponent(src)
  assert.equal(byComponent.Storybook.path, '/storybook/*')
  assert.equal(byComponent.GuestShipmentContainer.path, '/guest')
})

test('parseRoutes: createBrowserRouter object routes; skips Outlet wrappers', () => {
  const src = `
    const routes = [
      { path: '/', element: <Root />, children: [
        { path: 'apps', element: <Outlet />, children: X },
        { path: 'apps/dashboard', element: <Dashboard /> },
      ] },
    ]`
  const components = parseRoutes(src).map((route) => route.component)
  assert.ok(components.includes('Root'))
  assert.ok(components.includes('Dashboard'))
  assert.ok(!components.includes('Outlet'))
})

test('importMap: default, named (with alias), and lazy dynamic imports', () => {
  const src = `
    import Loggers from './Loggers'
    import { Assets, Foo as Bar } from 'AssetManagement/Assets'
    const Shipments = lazy(() => import('./Shipments/Shipments'))
    const AddShipment = React.lazy(() => import('./tabs/AddShipment'))`
  const specifiers = importMap(src)
  assert.equal(specifiers.Loggers, './Loggers')
  assert.equal(specifiers.Assets, 'AssetManagement/Assets')
  assert.equal(specifiers.Bar, 'AssetManagement/Assets') // aliased name
  assert.equal(specifiers.Shipments, './Shipments/Shipments') // lazy
  assert.equal(specifiers.AddShipment, './tabs/AddShipment') // React.lazy
})

test('extractEndpointsFromText: use*Endpoints hooks (quotes + interpolation)', () => {
  const src =
    'useBackendEndpoints(\'admin/companies\'); useFooEndpoints(`companies/${id}/settings`); useBarEndpoints("assets")'
  const endpoints = [...extractEndpointsFromText(src)].sort()
  assert.deepEqual(endpoints, ['admin/companies', 'assets', 'companies/{id}/settings'])
})

test('extractApiCallsFromText: axios/fetch/method + template URLs; strips host/version', () => {
  const src = [
    'axios.post(`${SKYGATE_URL}gateway/000002/installation-confirmation?x=1`)',
    "client.get('/gateways')",
    "fetch('users/preferences')",
    "http.get('https://api.meridian.example/v1')", // bare version → dropped
  ].join('\n')
  const endpoints = [...extractApiCallsFromText(src)].sort()
  assert.ok(
    endpoints.includes('gateway/000002/installation-confirmation'),
    'template URL path, query stripped',
  )
  assert.ok(endpoints.includes('gateways'), 'method-call literal, leading slash trimmed')
  assert.ok(endpoints.includes('users/preferences'))
  assert.ok(!endpoints.includes('v1'), 'bare version prefix filtered out')
})

// The design-system package list is config.json `uiPackages`, so this drives the parser with
// whatever is configured — and skips when nothing is, since then there is no import to recognise.
test(
  'extractUiComponents: named imports from a configured UI package, by export name',
  { skip: UI_PACKAGES.length ? false : 'no uiPackages configured' },
  () => {
    const uiPackage = UI_PACKAGES[0]
    const src = `
    import { Card, DataTable } from '${uiPackage}'
    import { PageHeader as Header, TOOLTIP_TYPE } from '${uiPackage}'
    import { Unrelated } from 'some-other-pkg'`
    const components = [...extractUiComponents(src)].sort()
    assert.ok(components.includes('Card') && components.includes('DataTable'))
    assert.ok(components.includes('PageHeader'), 'uses the exported name, not the local alias')
    assert.ok(!components.includes('Unrelated'), 'non-ui packages are ignored')
  },
)

test(
  'extractUiComponents: every configured package name is recognised',
  { skip: UI_PACKAGES.length < 2 ? 'only one uiPackage configured' : false },
  () => {
    // A package mid-rename is pinned under both names across the estate; both must collapse onto the
    // one hub, or the consumers still on the old name silently drop off it.
    for (const uiPackage of UI_PACKAGES) {
      const components = extractUiComponents(`import { Thing } from '${uiPackage}'`)
      assert.ok(components.has('Thing'), uiPackage)
    }
  },
)

test('normalizeEndpoint: interpolation → {id}, slashes trimmed', () => {
  assert.equal(normalizeEndpoint('/companies/${id}/settings/'), 'companies/{id}/settings')
  assert.equal(normalizeEndpoint('${cond ? a : b}/x'), 'x') // conditional fragment dropped
})

test('readTsPaths: keeps "/*" inside strings while stripping comments and trailing commas', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screens-tsconfig-'))
  fs.writeFileSync(
    path.join(repoDir, 'tsconfig.json'),
    `{
      /* block comment */
      "compilerOptions": {
        "baseUrl": ".", // line comment
        "paths": { "@/*": ["src/*"], "~/*": ["./lib/*"], },
        "strict": true /* a later block comment */
      },
    }`,
  )
  assert.deepEqual(readTsPaths(repoDir), { baseUrl: '.', paths: { '@/*': ['src/*'], '~/*': ['./lib/*'] } })
  fs.rmSync(repoDir, { recursive: true, force: true })
})

test('parseRoutes: looks through wrapper elements to the screen component', () => {
  const src = `
    const routes = [
      { element: <Suspense fallback={<Spinner />}><Lazy /></Suspense>, path: '/lazy' },
      { element: (<RequireAuth><Layout><Dashboard /></Layout></RequireAuth>), path: '/guarded' },
    ]
    <Route path="/jsx" element={<Suspense><JsxLazy /></Suspense>} />`
  const byComponent = routesByComponent(src)
  assert.equal(byComponent.Lazy?.path, '/lazy')
  assert.equal(byComponent.Dashboard?.path, '/guarded')
  assert.equal(byComponent.JsxLazy?.path, '/jsx')
  assert.ok(!byComponent.Spinner, 'a Suspense fallback is not the screen')
  assert.ok(!byComponent.RequireAuth && !byComponent.Layout, 'wrappers are not the screen')
})
