import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test.beforeEach(async ({ page }) => {
  const path = '/__workspace-updates'
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
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-updates-harness-app.tsx')
  )
})

for (const selection of ['pointer', 'keyboard'] as const) {
  for (const dismissal of ['Close', 'Escape'] as const) {
    test(`Updates ${selection} selection restores its trigger after ${dismissal} and reopening`, async ({
      page,
    }) => {
      const trigger = page.getByRole('button', { name: 'User settings', exact: true })
      for (let cycle = 0; cycle < 2; cycle++) {
        await trigger.focus()
        await page.keyboard.press('Enter')
        const item = page.getByRole('menuitem', { name: 'Updates', exact: true })
        if (selection === 'pointer') await item.click()
        else {
          await expect(page.getByRole('menuitem', { name: 'About', exact: true })).toBeFocused()
          await page.keyboard.press('ArrowDown')
          // Help Center and Send Feedback sit between About and Updates in
          // the enabled chain.
          await expect(
            page.getByRole('menuitem', { name: 'Help Center', exact: true })
          ).toBeFocused()
          await page.keyboard.press('ArrowDown')
          await expect(
            page.getByRole('menuitem', { name: 'Send Feedback', exact: true })
          ).toBeFocused()
          await page.keyboard.press('ArrowDown')
          await expect(item).toBeFocused()
          await page.keyboard.press('Enter')
        }
        const dialog = page.getByRole('dialog', { name: 'Version & updates', exact: true })
        await expect(dialog).toBeVisible()
        await expect(page.locator('#updates-opener')).toHaveText('User settings')
        if (dismissal === 'Close')
          await dialog.getByRole('button', { name: 'Close', exact: true }).click()
        else await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        await expect(trigger).toBeFocused()
      }
    })
  }
}

test('an unavailable Updates handler keeps normal menu focus restoration', async ({ page }) => {
  await page.getByRole('button', { name: 'Disable updates handoff' }).click()
  const trigger = page.getByRole('button', { name: 'User settings', exact: true })
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Updates', exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(trigger).toBeFocused()
})
