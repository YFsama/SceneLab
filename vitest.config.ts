import { defineConfig } from 'vitest/config'

// Unit tests run on jsdom. The React plugin is intentionally omitted: esbuild
// handles the TS/TSX transform for tests, and pulling the plugin in here clashes
// with the Vite version bundled inside Vitest.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // The voxel-based boolean/geometry tests can take a couple of seconds each;
    // a generous timeout keeps them from flaking past the 5s default under load.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
