import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // Injected from package.json so the UI (drawing title block, About) shows
    // the real app version without a second source of truth.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    rollupOptions: {
      output: {
        // Split the heavy vendors out of the 1.4 MB app chunk: three.js and
        // React change on different release cadences than app code, so
        // separate chunks cache independently and load in parallel.
        manualChunks(id: string) {
          if (id.includes('node_modules/three') || id.includes('node_modules/@types/three')) return 'vendor-three'
          if (id.includes('node_modules/three-mesh-bvh')) return 'vendor-three'
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/') || id.includes('node_modules/scheduler')) return 'vendor-react'
          if (id.includes('node_modules/lucide-react')) return 'vendor-icons'
          // Heavy io layer (STEP export is the biggest single io module).
          // Everything under src/lib/io is re-exported through io/index.ts,
          // which the entry graph imports statically (store, projectActions,
          // registry, ProjectMenu, builtinTools) — so rolldown can never
          // lazy-split it (the INEFFECTIVE_DYNAMIC_IMPORT audit) and the
          // whole layer rode along in the 767 kB main chunk. Pinning it into
          // an 'io' chunk moves those bytes out of main into a chunk that
          // caches independently and loads in parallel; the dynamic
          // importers (ViewportCanvas export menu, AI) resolve to the same
          // chunk — no duplication.
          if (id.includes('/src/lib/io/')) return 'io'
        },
      },
    },
  },
  // Tauri uses a fixed dev port and should not have Vite clear the terminal.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
})
