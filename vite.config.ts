import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Tauri uses a fixed dev port and should not have Vite clear the terminal.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
})
