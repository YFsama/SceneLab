import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests run against the Vite dev server. Chromium-only keeps the
 * matrix lean; the app targets evergreen browsers anyway. The port is
 * overridable via E2E_PORT for hosts where something unkillable (e.g.
 * Docker Desktop's proxy) squats on the default.
 */
const E2E_PORT = process.env.E2E_PORT ?? '5174';
const E2E_URL = `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  use: {
    // 127.0.0.1, not localhost: on some machines Vite binds IPv6 ::1 only and
    // an IPv4 probe (or vice versa) never becomes ready.
    baseURL: E2E_URL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // 5173 is Tauri's fixed dev port (strictPort in vite.config) and may be
    // held by unrelated processes — E2E uses its own port via the CLI.
    // --host 127.0.0.1 pins the IPv4 loopback so the readiness probe and the
    // browser hit the same interface (default localhost can bind ::1 only).
    command: `npx vite --port ${E2E_PORT} --strictPort --host 127.0.0.1`,
    url: E2E_URL,
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
