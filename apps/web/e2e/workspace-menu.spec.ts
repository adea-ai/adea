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
  await page.getByRole('menuitem', { name: 'Send Feedback', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Selected action' })).toHaveText('feedback')
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

test('the rail carries a static product mark and the global shortcut dispatches once', async ({
  page,
}) => {
  const path = '/__global-workspace-rail'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  const entry = resolve(process.cwd(), 'apps/web/e2e/helpers/global-workspace-rail-harness-app.tsx')
  await page.evaluate(async (url) => {
    await import(url)
  }, '/@fs' + entry)

  // Workspaces are switched from the contextual sidebar (ADR 0011): the rail
  // header is the Adea mark only, with no switcher button or menu.
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  const mark = rail.locator('.global-rail__mark')
  await expect(mark).toBeVisible()
  await expect(mark.locator('button, [role="button"], [tabindex]')).toHaveCount(0)
  await expect(rail.getByRole('button', { name: /Switch workspace/ })).toHaveCount(0)
  // The mark keeps the rail row rhythm: it is exactly one rail item tall.
  const rhythm = await mark.evaluate((element) => {
    const firstItem = document.querySelector<HTMLElement>('[aria-label="Search workspace"]')!
    return {
      mark: element.getBoundingClientRect().height,
      item: firstItem.getBoundingClientRect().height,
    }
  })
  expect(Math.abs(rhythm.mark - rhythm.item)).toBeLessThanOrEqual(1)

  for (const [index, view] of ['Virtual view', 'Chat view', 'Dev view', 'App Library'].entries()) {
    await page.getByRole('button', { name: `Use ${view}` }).click()
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('status', { name: 'Global search requests' })).toHaveText(
      String(index + 1)
    )
    await expect(page.getByRole('status', { name: 'Chat search requests' })).toHaveText('0')
    await page.keyboard.press('Escape')
  }
})
