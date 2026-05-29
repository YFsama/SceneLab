import { defineConfig } from 'vitest/config'

// Unit tests run on jsdom. The React plugin is intentionally omitted: esbuild
// handles the TS/TSX transform for tests, and pulling the plugin in here clashes
// with the Vite version bundled inside Vitest.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
