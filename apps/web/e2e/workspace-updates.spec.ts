import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('closing Updates from the account menu restores focus to its persistent trigger', async ({
  page,
}) => {
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
  const trigger = page.getByRole('button', { name: 'User settings', exact: true })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Updates', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Version & updates', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})
