import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// jsdom so graph.js can import 'reactflow' (it pulls React) without a real browser, and so the
// component tests can render. The app's JSX needs the automatic runtime (no `import React`).
// The alias mirrors vite.config.mjs so the golden-path screen loads under test.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@golden-path': fileURLToPath(new URL('../golden-path', import.meta.url)) } },
  test: { environment: 'jsdom', include: ['src/**/*.test.{js,jsx}'] },
})
