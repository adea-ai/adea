import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test.beforeEach(async ({ page }) => {
  const path = '/__account-drawer'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/account-drawer-harness-app.tsx')
  )
})

test('account drawer uses the shared scrim, responsive width and focus restoration', async ({
  page,
}) => {
  const trigger = page.getByRole('button', { name: 'Open user menu for Sign in' })
  await expect(page.locator('#account-trigger-target').getByRole('button')).toHaveCount(1)
  await trigger.click()

  const dialog = page.getByRole('dialog', { name: 'Sign in', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('data-side', 'right')
  await expect(dialog.getByText('Guest workspace · sign in anytime')).toBeVisible()
  await expect(page.locator('[class*="bg-scrim/50"]')).toHaveCount(1)
  await expect(dialog.locator('.overflow-y-auto')).toHaveCSS('overflow-y', 'auto')
  const rootFontSize = await page
    .locator('html')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
  expect(
    await dialog.evaluate((element) => Number.parseFloat(getComputedStyle(element).width))
  ).toBeCloseTo(Math.min(24 * rootFontSize, 0.9 * 1280), 1)

  await page.setViewportSize({ width: 320, height: 700 })
  expect(
    await dialog.evaluate((element) => Number.parseFloat(getComputedStyle(element).width))
  ).toBeCloseTo(Math.min(24 * rootFontSize, 0.9 * 320), 1)

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('account drawer preserves sign-in and sign-out actions and labels', async ({ page }) => {
  let trigger = page.getByRole('button', { name: 'Open user menu for Sign in' })
  await trigger.click()

  let dialog = page.getByRole('dialog', { name: 'Sign in', exact: true })
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Selected action' })).toHaveText('sign-in')
  await expect(dialog).toHaveCount(0)

  trigger = page.getByRole('button', { name: 'Open user menu for Adea owner' })
  await expect(trigger).toBeFocused()
  await trigger.click()
  dialog = page.getByRole('dialog', { name: 'Adea owner', exact: true })
  await expect(dialog.getByText('Signed in · workspace saved')).toBeVisible()
  await dialog.getByRole('button', { name: 'Sign out', exact: true }).click()

  await expect(page.getByRole('status', { name: 'Selected action' })).toHaveText('sign-out')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open user menu for Sign in' })).toBeFocused()
})

test('account drawer closes when its panel is dragged outward', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 })
  const trigger = page.getByRole('button', { name: 'Open user menu for Sign in' })
  await trigger.click()

  const dialog = page.getByRole('dialog', { name: 'Sign in', exact: true })
  await expect(dialog).toBeVisible()
  const box = await dialog.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + 8, box!.y + 120)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width - 8, box!.y + 120, { steps: 8 })
  await page.mouse.up()

  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})
