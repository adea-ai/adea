import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style')
      style.textContent = 'nextjs-portal { display: none !important; }'
      document.head.append(style)
    })
  })
})

test('settings dialog controls carry the pointer cursor and intended layout', async ({ page }) => {
  await page.goto('/#settings/appearance')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'test-results/probe-settings-appearance.png' })

  // Dropdown menu items must carry the pointer cursor.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'User settings' }).click()
  await page.waitForTimeout(400)
  const menuCursor = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')]
    return items.map((item) => getComputedStyle(item).cursor)
  })
  console.log('DROPDOWN CURSORS:', JSON.stringify(menuCursor))
  await page.screenshot({ path: 'test-results/probe-account-menu.png' })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Switch workspace/i }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/probe-workspace-menu.png' })

  expect(menuCursor.length).toBeGreaterThan(0)
  expect(new Set(menuCursor)).toEqual(new Set(['pointer']))
})
