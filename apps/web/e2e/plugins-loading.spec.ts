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
  const status = dialog.getByRole('status').first()
  const loadingSurface = dialog.locator('[aria-busy="true"][aria-label="Loading plugins"]')
  await expect(status).toHaveText('Loading plugins')
  const element = await status.elementHandle()
  expect(await status.evaluate((node) => node.closest('[aria-busy="true"]'))).toBeNull()
  await expect(loadingSurface).toHaveCount(1)
  await page.evaluate(() => window.pluginsLoadingHarness.complete())
  await expect(status).toHaveText('0 plugins')
  expect(await element!.evaluate((node) => node.isConnected)).toBe(true)
  await expect(loadingSurface).toHaveCount(0)
  await expect(dialog.getByText('No matching plugins')).toBeVisible()
  const filter = dialog.getByRole('button', { name: 'Filter', exact: true })
  await filter.click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.getByRole('menuitemradio', { name: 'Skills', exact: true }).click()
  await expect(page.getByRole('menuitemradio', { name: 'Skills', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(filter).toHaveAttribute('aria-pressed', 'true')
  await filter.click()
  await expect(page.getByRole('menuitemradio', { name: 'Skills', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(filter).toBeFocused()
})
