import { defineConfig } from 'vitest/config'

// jsdom so graph.js can import 'reactflow' (it pulls React) without a real browser.
export default defineConfig({
  test: { environment: 'jsdom', include: ['src/**/*.test.{js,jsx}'] },
})
