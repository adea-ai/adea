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

test('workspace picker uses menu keyboard behavior and the global shortcut dispatches once', async ({
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

  const trigger = page.locator('.global-rail__workspace-trigger')
  await trigger.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu')
  const workItem = menu.getByRole('menuitemradio', { name: 'Work' })
  const homeItem = menu.getByRole('menuitemradio', { name: 'Home' })
  await expect(menu).toBeVisible()
  await menu.evaluate((element) =>
    Promise.allSettled(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished)
    )
  )
  await expect(workItem).toHaveAttribute('aria-checked', 'true')
  await expect(workItem).toBeFocused()
  const placement = await menu.evaluate((element) => {
    const menuRect = element.getBoundingClientRect()
    const triggerRect = document
      .querySelector<HTMLElement>('.global-rail__workspace-trigger')!
      .getBoundingClientRect()
    return {
      menuLeft: menuRect.left,
      menuRight: menuRect.right,
      triggerRight: triggerRect.right,
      viewportWidth: window.innerWidth,
    }
  })
  expect(placement.menuLeft).toBeGreaterThanOrEqual(placement.triggerRight - 1)
  expect(placement.menuRight).toBeLessThanOrEqual(placement.viewportWidth)
  await page.keyboard.press('ArrowDown')
  await expect(homeItem).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status', { name: 'Selected workspace' })).toHaveText(
    'workspace-home'
  )
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await trigger.click()
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()

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
