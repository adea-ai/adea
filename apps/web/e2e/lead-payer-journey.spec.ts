import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import solid from 'vite-plugin-solid'

let server: ViteDevServer | undefined
let cacheDir = ''
let url = ''
test.beforeAll(async () => {
  const root = resolve(process.cwd(), 'apps/web')
  const harness = '/@fs' + resolve(root, 'e2e/helpers/lead-payer-journey-harness-app.tsx')
  // A private optimizer cache. The managed dev server owns node_modules/.vite; this instance must
  // not rewrite the dependency hashes that a running app has already requested.
  cacheDir = mkdtempSync(join(tmpdir(), 'adea-lead-payer-vite-'))
  server = await createServer({
    configFile: false,
    root,
    cacheDir,
    // This module-only fixture serves no public assets. Preserve unrelated sync copies.
    publicDir: false,
    // Serve this ESM fixture graph directly; do not scan unrelated application HTML/assets.
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: 'error',
    plugins: [
      solid(),
      {
        name: 'lead-payer-mounted-fixture',
        configureServer(fixture) {
          fixture.middlewares.use('/__lead-payer', (_request, response) => {
            response.setHeader('Content-Type', 'text/html')
            response.end(
              `<html><body><div id="harness-root"></div><script type="module" src="${harness}"></script></body></html>`
            )
          })
        },
      },
    ],
    resolve: { dedupe: ['solid-js'], conditions: ['solid', 'browser', 'development'] },
    // The fixture modules are static; no HMR or repository-wide asset watcher is needed.
    server: { watch: null, host: '127.0.0.1', port: 0, strictPort: true },
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Lead fixture did not bind')
  url = `http://127.0.0.1:${address.port}/__lead-payer`
})
test.afterAll(async () => {
  await server?.close()
  rmSync(cacheDir, { recursive: true, force: true })
})

// These mounted tests use scripted API responses, independently of the blocked CP selection seam.
async function review(page: import('@playwright/test').Page) {
  await page.goto(url)
  await page.getByRole('button', { name: 'Review model and payer', exact: true }).click()
  const disclosure = page.getByLabel('Current model and payer')
  await expect(disclosure).toContainText('Provider: scripted-provider · Model: chosen-model')
  await expect(disclosure).toContainText('Account: provider-account:separate-from-payer')
  await expect(disclosure).toContainText('Authentication: api_key')
  await expect(disclosure).toContainText('Funding: byo_api · Payer: Recorded workspace payer')
  await expect(disclosure).toContainText('workspace_account, payer:recorded-owner')
  await expect(page.getByLabel('Prepare requests')).toHaveText('1')
  await expect(page.getByLabel('Start requests')).toHaveText('0')
  await expect(page.getByRole('button', { name: 'Start lead turn', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Confirm this model and payer', exact: true }).click()
}

test('exact payer must be reviewed before explicit start; cancellation acknowledgement is not termination', async ({
  page,
}) => {
  await review(page)
  await page.getByRole('button', { name: 'Start lead turn', exact: true }).click()
  await expect(page.getByLabel('Start requests')).toHaveText('1')
  await page.getByRole('button', { name: 'Request cancellation', exact: true }).click()
  await expect(page.getByLabel('Cancel requests')).toHaveText('1')
  await expect(page.getByText('Cancellation requested', { exact: true })).toBeVisible()
  await expect(
    page.getByText('The outcome and any provider charge remain unconfirmed', { exact: false })
  ).toBeVisible()
  await expect(page.getByLabel('Timeline changes')).toHaveText('0')
  await expect(page.getByLabel('Independent draft')).toHaveValue('Unsent independent draft')
})

test('changed payer revision after review blocks start without silently admitting a new attempt', async ({
  page,
}) => {
  await review(page)
  await page.getByRole('button', { name: 'Change recorded payer revision' }).click()
  await page.getByRole('button', { name: 'Start lead turn', exact: true }).click()
  await expect(
    page.getByText('A new canonical admission is required; retry controls are not yet available.', {
      exact: false,
    })
  ).toBeVisible()
  await expect(page.getByLabel('Start requests')).toHaveText('0')
  await expect(page.getByLabel('Prepare requests')).toHaveText('1')
  await expect(page.getByLabel('Independent draft')).toHaveValue('Unsent independent draft')
})

test('audience invalidation while funding is awaited cannot dispatch from an old confirmation', async ({
  page,
}) => {
  await review(page)
  await page.getByRole('button', { name: 'Hold funding response' }).click()
  await page.getByRole('button', { name: 'Start lead turn', exact: true }).click()
  await page.getByRole('button', { name: 'Invalidate audience' }).click()
  await page.getByRole('button', { name: 'Release funding response' }).click()
  await expect(page.getByLabel('Settled funding responses')).toHaveText('3')
  await expect(
    page.getByRole('button', { name: 'Confirm this model and payer', exact: true })
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start lead turn', exact: true })).toBeDisabled()
  await expect(page.getByLabel('Start requests')).toHaveText('0')
  await expect(page.getByLabel('Timeline changes')).toHaveText('0')
})
