import { defineConfig, devices } from '@playwright/test'

const input = process.env.ADEA_START_PREVIEW_URL
if (!input || process.env.ADEA_START_ISOLATED_TEST_TARGET !== '1') {
  throw new Error(
    'Set ADEA_START_PREVIEW_URL and explicitly acknowledge an isolated test backend with ADEA_START_ISOLATED_TEST_TARGET=1'
  )
}
const url = new URL(input)
if (
  !['http:', 'https:'].includes(url.protocol) ||
  url.username ||
  url.password ||
  url.pathname !== '/' ||
  url.search ||
  url.hash
) {
  throw new Error(
    'The preview target must be an HTTP(S) origin without credentials, path, query or fragment'
  )
}
if (url.hostname === 'adea.dev' || url.hostname.endsWith('.adea.dev')) {
  throw new Error('Do not run the staged migration tests against the production Adea domain')
}

export default defineConfig({
  testDir: '..',
  testMatch: ['e2e/workspace-guest.spec.ts', 'start-preview/browser/*.e2e.ts'],
  // No webServer block: never launch the current Next host accidentally and
  // report its results as a Start proof. The isolated gateway must be running.
  timeout: 90_000,
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  outputDir: './test-results',
  reporter: [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]],
  use: {
    baseURL: url.origin,
    headless: true,
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
  ],
})
