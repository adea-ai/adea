import { defineConfig, devices } from '@playwright/test'

// PERF_BASE_URL points the suite at an already-running server and disables
// the managed webServer below. E2E_PORT is the local-run escape from the
// shared port 3000: the managed server starts on 127.0.0.1:<E2E_PORT> with
// --strictPort, so a stale or foreign listener can never be silently reused
// (the local lane reuses an existing server on the default port). CI leaves
// both unset and gets the historical behavior unchanged.
const isolatedPort = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : undefined
if (isolatedPort !== undefined && (!Number.isInteger(isolatedPort) || isolatedPort < 1024)) {
  throw new Error(`E2E_PORT must be an integer >= 1024, got ${process.env.E2E_PORT}`)
}
const baseURL =
  process.env.PERF_BASE_URL ??
  (isolatedPort === undefined ? 'http://localhost:3000' : `http://127.0.0.1:${isolatedPort}`)
// The E2E web server boots the app, which needs a migrated database. CI and
// local shells without DATABASE_URL fall back to the compose Postgres that
// scripts/e2e-setup.mjs starts (same defaults as test-integration.mjs).
const e2eDatabaseEnvironment = process.env.DATABASE_URL
  ? {}
  : {
      DATABASE_URL:
        'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable',
      DATABASE_URL_UNPOOLED:
        'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable',
      DATABASE_MIGRATION_URL:
        'postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55432/agent_hq?sslmode=disable',
    }
const headless = process.env.PLAYWRIGHT_HEADLESS ? process.env.PLAYWRIGHT_HEADLESS === '1' : true

export default defineConfig({
  testDir: 'apps/web/e2e',
  testMatch: '**/*.spec.ts',
  // Guest coverage walks the chat workspace and the engine-unavailable
  // fallback; WebGL scene gates live with the engine in Agent Sim.
  timeout: 90_000,
  // These gates create real WebGL contexts; serializing them avoids GPU and
  // asset-load contention that would make the measurements nondeterministic.
  fullyParallel: false,
  workers: 1,
  // A dev server can stall a page's first module-graph load while Vite
  // re-optimizes dependencies (the transport flake the visual lane's warm-up
  // step documents), so element expectations outwait the 5s default instead of
  // reporting a cold chunk load as a product failure. Screenshot comparisons
  // keep their own shorter budget via expect.toHaveScreenshot defaults.
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    headless,
    navigationTimeout: 120_000,
    ignoreHTTPSErrors: true,
    // Headless Chromium selects SwiftShader on macOS, and forcing Metal in
    // headless mode can stall shader compilation. A visible, hardware-backed
    // browser keeps the 3D gate representative and deterministic on Mac.
    launchOptions:
      process.platform === 'darwin' && !headless ? { args: ['--use-angle=metal'] } : undefined,
    trace: 'retain-on-failure',
  },
  webServer: process.env.PERF_BASE_URL
    ? undefined
    : {
        command: isolatedPort
          ? `cd apps/web && bun run dev -- --port ${isolatedPort} --strictPort --host 127.0.0.1`
          : 'cd apps/web && bun run dev',
        url: baseURL,
        reuseExistingServer: !process.env.CI && isolatedPort === undefined,
        timeout: 120_000,
        env: { ...process.env, ...e2eDatabaseEnvironment },
      },
})
