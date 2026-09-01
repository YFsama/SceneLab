import { defineConfig, devices } from '@playwright/test';

/**
 * E2E smoke tests run against the Vite dev server. Chromium-only keeps the
 * matrix lean; the app targets evergreen browsers anyway.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // 5173 is Tauri's fixed dev port (strictPort in vite.config) and may be
    // held by unrelated processes — E2E uses its own port via the CLI.
    command: 'npx vite --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // Developer machines may run a system proxy (e.g. 127.0.0.1:7890) that
    // intercepts localhost and breaks the readiness probe with a 502.
    env: {
      ...process.env,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
    },
  },
});
