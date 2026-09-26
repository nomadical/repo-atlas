import { defineConfig } from 'vitest/config'

// jsdom so graph.js can import 'reactflow' (it pulls React) without a real browser, and so the
// component tests can render. The app's JSX needs the automatic runtime (no `import React`).
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { environment: 'jsdom', include: ['src/**/*.test.{js,jsx}'] },
})
