import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('plugin loading reports progress outside busy decorative placeholders', async ({ page }) => {
  const path = '/__plugins-loading'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  const entry = resolve(process.cwd(), 'apps/web/e2e/helpers/plugins-loading-harness-app.tsx')
  await page.evaluate(async (url) => {
    await import(url)
  }, '/@fs' + entry)
  const dialog = page.getByRole('dialog', { name: 'Plugins', exact: true })
  const status = dialog.getByRole('status')
  await expect(status).toHaveText('Loading plugins')
  const element = await status.elementHandle()
  expect(await status.evaluate((node) => node.closest('[aria-busy="true"]'))).toBeNull()
  await expect(dialog.locator('.plugins-browser__skeleton')).toHaveAttribute('aria-busy', 'true')
  await expect(dialog.locator('.plugins-browser__skeleton')).not.toHaveAttribute('aria-label')
  await page.evaluate(() => window.pluginsLoadingHarness.complete())
  await expect(status).toHaveText('0 plugins')
  expect(await element!.evaluate((node) => node.isConnected)).toBe(true)
  await expect(dialog.locator('.plugins-browser__skeleton')).toHaveCount(0)
  await expect(dialog.getByText('No matching plugins')).toBeVisible()
})
