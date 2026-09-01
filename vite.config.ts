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
  // Tauri uses a fixed dev port and should not have Vite clear the terminal.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
})
