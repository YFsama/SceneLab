import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }

// Unit tests run on jsdom. The React plugin is intentionally omitted: esbuild
// handles the TS/TSX transform for tests, and pulling the plugin in here clashes
// with the Vite version bundled inside Vitest.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // The voxel-based boolean/geometry tests can take a couple of seconds each;
    // a generous timeout keeps them from flaking past the 5s default under load.
    testTimeout: 20000,
    hookTimeout: 20000,
    setupFiles: ['./src/test/setup.ts'],
  },
})
