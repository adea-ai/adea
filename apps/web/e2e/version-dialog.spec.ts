import { expect, test } from '@playwright/test'
import { type AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import solid from 'vite-plugin-solid'

const fixtureRoot = fileURLToPath(
  new URL('../../../packages/ui/tests/fixtures/version-dialog/', import.meta.url)
)
const uiRoot = resolve(fixtureRoot, '../../..')

let fixtureServer: ViteDevServer | undefined
let fixtureUrl = ''

test.beforeAll(async () => {
  fixtureServer = await createServer({
    configFile: false,
    clearScreen: false,
    logLevel: 'error',
    root: fixtureRoot,
    plugins: [solid()],
    resolve: {
      alias: [
        {
          find: /^#components\//,
          replacement: `${resolve(uiRoot, 'src/components')}/`,
        },
        {
          find: /^#lib\//,
          replacement: `${resolve(uiRoot, 'src/lib')}/`,
        },
      ],
      dedupe: ['solid-js'],
    },
    server: { host: '127.0.0.1', port: 0, strictPort: true },
  })
  await fixtureServer.listen()

  const address = fixtureServer.httpServer?.address()
  if (!address || typeof address === 'string') {
    throw new Error('Updater fixture server did not bind an HTTP port')
  }
  fixtureUrl = `http://127.0.0.1:${(address as AddressInfo).port}`
})

test.afterAll(async () => {
  await fixtureServer?.close()
})

async function openFixture(
  page: import('@playwright/test').Page,
  failure: string,
  initial?: 'available',
  reload?: 'available'
) {
  const params = new URLSearchParams({ failure })
  if (initial) params.set('initial', initial)
  if (reload) params.set('reload', reload)
  await page.goto(`${fixtureUrl}/?${params}`)
  await expect(page.getByRole('dialog', { name: 'Version & updates' })).toBeVisible()
}

async function expectNoCurrentClaim(page: import('@playwright/test').Page) {
  await expect(page.getByText('Adea is up to date.', { exact: true })).toHaveCount(0)
  await expect(
    page.getByText('You are running the latest desktop release.', { exact: true })
  ).toHaveCount(0)
}

test('a failed auto-check hides stale current status and retry recovers', async ({ page }) => {
  await openFixture(page, 'structured')

  const alert = page.getByRole('alert')
  await expect(alert).toHaveText('The update feed is temporarily unavailable.')
  await expectNoCurrentClaim(page)
  await expect(page.getByText('test-token-must-not-render', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Retry update check' }).click()
  await expect(page.getByText('Adea is up to date.', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

for (const [failure, message] of [
  ['error', 'Update feed request timed out.'],
  ['string', 'The update service could not be reached.'],
  ['unknown', 'Could not check for updates'],
  ['unsafe-message', 'Could not check for updates'],
  ['unsafe-nested-message', 'Could not check for updates'],
  ['failed-status', 'Could not check for updates'],
] as const) {
  test(`shows a safe retry message for ${failure} failures`, async ({ page }) => {
    await openFixture(page, failure)

    await expect(page.getByRole('alert')).toHaveText(message)
    await expectNoCurrentClaim(page)
    await expect(page.getByRole('button', { name: 'Retry update check' })).toBeEnabled()
    await expect(page.getByText('test-token-must-not-render', { exact: true })).toHaveCount(0)
  })
}

test('a failed check preserves an already loaded available update', async ({ page }) => {
  await openFixture(page, 'structured', 'available')

  await expect(page.getByRole('alert')).toHaveText('The update feed is temporarily unavailable.')
  await expect(page.getByText('Version 0.64.0 is ready', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Install and restart' })).toBeEnabled()
  await expectNoCurrentClaim(page)
})

test('a failed manual check reloads an available update and install clears retry state', async ({
  page,
}) => {
  await openFixture(page, 'manual-structured', undefined, 'available')

  await expect(page.getByText('Adea is up to date.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Check latest version' }).click()
  await expect(page.getByRole('alert')).toHaveText('The update feed is temporarily unavailable.')
  await expect(page.getByText('Version 0.64.0 is ready', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry update check' })).toBeVisible()

  await page.getByRole('button', { name: 'Install and restart' }).click()
  await expect(page.getByRole('button', { name: 'Check latest version' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Retry update check' })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a late manual check cannot overwrite a newer auto-check after reopen', async ({ page }) => {
  await openFixture(page, 'race')
  await expect(page.getByTestId('check-count')).toHaveText('1')
  await expect(page.getByText('Adea is up to date.', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Check latest version' }).click()
  await expect(page.getByTestId('check-count')).toHaveText('2')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Version & updates' })).toHaveCount(0)

  await page.evaluate(() => window.dispatchEvent(new Event('open-version-dialog')))
  await expect(page.getByTestId('check-count')).toHaveText('3')
  await expect(page.getByText('Adea is up to date.', { exact: true })).toBeVisible()

  await page.evaluate(() => window.dispatchEvent(new Event('reject-manual-check')))
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText('Adea is up to date.', { exact: true })).toBeVisible()
})
