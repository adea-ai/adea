import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PERF_BASE_URL ?? "http://localhost:3000";

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
    headless: process.platform !== "darwin",
    ignoreHTTPSErrors: true,
    // Headless Chromium selects SwiftShader on macOS, and forcing Metal in
    // headless mode can stall shader compilation. A visible, hardware-backed
    // browser keeps the 3D gate representative and deterministic on Mac.
    launchOptions: process.platform === "darwin" ? { args: ["--use-angle=metal"] } : undefined,
    trace: "retain-on-failure",
  },
  webServer: process.env.PERF_BASE_URL
    ? undefined
    : {
        command: "cd apps/web && bun run dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
