import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('account menu dispatches published menu actions and restores keyboard focus', async ({
  page,
}) => {
  const path = '/__workspace-menu'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  const entry = resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-menu-harness-app.tsx')
  await page.evaluate(async (url) => {
    await import(url)
  }, '/@fs' + entry)
  const trigger = page.getByRole('button', { name: 'User settings' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Get Adea mobile' })).toHaveAttribute(
    'data-disabled',
    ''
  )
  await page.getByRole('menuitem', { name: 'Updates', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Selected action' })).toHaveText('updates')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Selected action' })).toHaveText('sign-out')
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(trigger).toBeFocused()
})
