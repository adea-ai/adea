import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PERF_BASE_URL ?? "http://localhost:3000";
// The E2E web server boots the app, which needs a migrated database. CI and
// local shells without DATABASE_URL fall back to the compose Postgres that
// scripts/e2e-setup.mjs starts (same defaults as test-integration.mjs).
const e2eDatabaseEnvironment = process.env.DATABASE_URL
  ? {}
  : {
      DATABASE_URL:
        "postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable",
      DATABASE_URL_UNPOOLED:
        "postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable",
      DATABASE_MIGRATION_URL:
        "postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55432/agent_hq?sslmode=disable",
    };
const headless = process.env.PLAYWRIGHT_HEADLESS
  ? process.env.PLAYWRIGHT_HEADLESS === "1"
  : process.platform !== "darwin";

export default defineConfig({
  testDir: "apps/web/e2e",
  testMatch: "**/*.spec.ts",
  // One gate covers both a cold scene load and a cold Room Designer catalog.
  timeout: 90_000,
  // These gates create real WebGL contexts; serializing them avoids GPU and
  // asset-load contention that would make the measurements nondeterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    headless,
    navigationTimeout: 120_000,
    ignoreHTTPSErrors: true,
    // Headless Chromium selects SwiftShader on macOS, and forcing Metal in
    // headless mode can stall shader compilation. A visible, hardware-backed
    // browser keeps the 3D gate representative and deterministic on Mac.
    launchOptions:
      process.platform === "darwin" && !headless ? { args: ["--use-angle=metal"] } : undefined,
    trace: "retain-on-failure",
  },
  webServer: process.env.PERF_BASE_URL
    ? undefined
    : {
        command: "cd apps/web && bun run dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { ...process.env, ...e2eDatabaseEnvironment },
      },
});
