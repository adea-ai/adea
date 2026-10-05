import { expect, test } from '../start/browser/fixtures'

const workspace = {
  id: 'workspace-guest-e2e',
  name: 'My Adea',
  scene: 'home',
  updatedAt: '2026-08-25T00:00:00.000Z',
}

test('a guest can use a workspace before opening the optional persistence flow', async ({
  page,
}) => {
  await page.route('**/api/workspaces/bootstrap', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        activeWorkspace: workspace,
        principal: { temporary: true },
        workspaces: [workspace],
      },
    })
  })

  await page.goto('/?view=virtual')
  const userMenu = page.getByRole('button', { name: 'User settings' })
  await expect(userMenu).toBeVisible({ timeout: 20_000 })
  await expect(userMenu.locator('svg.lucide-user-round')).toHaveCount(1)
  // The virtual view renders the engine-unavailable fallback in builds
  // without Agent Sim; the designer entry points it used to host are gone.
  await expect(page.getByRole('status', { name: 'Virtual view unavailable' })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByRole('button', { name: 'Open character designer' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open user menu for Sign in' })).toHaveCount(0)
  await expect(page.locator('.workspace-statusbar')).toHaveCount(0)
  await expect(page.getByLabel('Workspace toolbar')).toBeVisible()

  const workspaceTrigger = page.getByRole('button', { name: /Switch workspace/ })
  await workspaceTrigger.click()
  const workspaceMenu = page.getByRole('menu', { name: /Switch workspace/ })
  await expect(workspaceMenu).toBeVisible({ timeout: 20_000 })
  await workspaceMenu.evaluate((menu) =>
    Promise.allSettled(menu.getAnimations({ subtree: true }).map((animation) => animation.finished))
  )
  const workspaceMenuPosition = await workspaceMenu.evaluate((menu) => {
    const menuBox = menu.getBoundingClientRect()
    const triggerBox = document
      .querySelector<HTMLElement>('.global-rail__workspace-trigger')!
      .getBoundingClientRect()
    return {
      menuLeft: menuBox.left,
      menuTop: menuBox.top,
      triggerRight: triggerBox.right,
      triggerTop: triggerBox.top,
    }
  })
  // The picker opens right-start with a 4px gutter. Allow sub-pixel differences
  // between renderers while checking the intended placement.
  expect(
    Math.abs(workspaceMenuPosition.menuLeft - workspaceMenuPosition.triggerRight - 4)
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(workspaceMenuPosition.menuTop - workspaceMenuPosition.triggerTop)
  ).toBeLessThanOrEqual(1)
  await workspaceTrigger.click()
  await expect(workspaceMenu).toBeHidden()

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    const layout = await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>('.global-rail')!
      const surface = document.querySelector<HTMLElement>('.workspace-frame__surface')!
      const railBox = rail.getBoundingClientRect()
      const surfaceBox = surface.getBoundingClientRect()
      return {
        railWidth: railBox.width,
        surfaceOffset: surfaceBox.left,
      }
    })
    // --rail-width moved 4.625rem (74px) to 3.5rem (56px) in @adea-ai/ui
    // 0.95.0; the grid column and the surface inset both track the token, so
    // the rail and the surface offset move together.
    expect(layout).toEqual({ railWidth: 56, surfaceOffset: 56 })
  }

  await userMenu.click()
  const accountMenu = page.getByRole('menu', { name: 'User settings' })
  // The menu enters with a zoom/fade animation that transforms its box; wait
  // for it to settle before measuring the final position.
  await accountMenu.evaluate((menu) =>
    Promise.allSettled(menu.getAnimations({ subtree: true }).map((a) => a.finished))
  )
  const accountMenuPosition = await accountMenu.evaluate((menu) => {
    const menuBox = menu.getBoundingClientRect()
    const triggerBox = document
      .querySelector<HTMLElement>('.global-rail__account-trigger')!
      .getBoundingClientRect()
    return {
      menuLeft: menuBox.left,
      menuBottom: menuBox.bottom,
      triggerRight: triggerBox.right,
      triggerBottom: triggerBox.bottom,
    }
  })
  // The AccountMenu composite opens right-end with a 4px gutter: the menu
  // sits beside the rail icon and the two boxes share a bottom edge, so its
  // bottom-left corner lands at the button's bottom-right. Allow sub-pixel
  // differences between renderers while checking the intended placement.
  expect(
    Math.abs(accountMenuPosition.menuLeft - accountMenuPosition.triggerRight - 4)
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(accountMenuPosition.menuBottom - accountMenuPosition.triggerBottom)
  ).toBeLessThanOrEqual(1)
  await expect(accountMenu.getByRole('menuitem', { name: 'Get Adea mobile' })).toBeDisabled()
  await expect(accountMenu.getByRole('menuitem', { name: 'Help Center' })).toBeEnabled()
  // Send Feedback is live: it opens the prefilled GitHub issue form
  // (.github/ISSUE_TEMPLATE/feedback.yml). Help Center opens the shared
  // shortcuts-and-resources dialog; both are available to guests.
  await expect(accountMenu.getByRole('menuitem', { name: 'Send Feedback' })).toBeEnabled()
  await expect(accountMenu.getByRole('menuitem', { name: 'Updates' })).toHaveCount(0)
  // The settings chord follows the running OS — ⌘, on Apple platforms, Ctrl,
  // elsewhere — so the glyph is matched, not spelled.
  await expect(accountMenu.getByRole('menuitem', { name: 'Settings' })).toContainText(/(⌘|Ctrl),/)
  await accountMenu.getByRole('menuitem', { name: 'About' }).click()
  const about = page.getByRole('dialog', { name: 'About Adea' })
  await expect(about).toBeVisible()
  await expect(about.getByText('Copyright © 2026 0xPlayerOne')).toBeVisible()
  // The dialog renders the app package version, which release automation bumps.
  // Match any semver so this gate survives releases (it must still be a real
  // version, never the "Version unavailable" fallback).
  await expect(about.getByText(/^Version \d+\.\d+\.\d+$/)).toBeVisible()
  await expect(about.getByRole('button', { name: 'Copy version info' })).toBeVisible()
  await expect(about.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  // The shared About dialog carries the real app icon.
  await expect(about.locator('img[src="/icon.svg"]')).toBeAttached()
  await about.getByRole('button', { name: 'Close', exact: true }).click()
  // Let the dialog (and its inert overlay) fully detach before opening the
  // next one; without the scene's render load this races close animations.
  await expect(about).toBeHidden({ timeout: 20_000 })
  // Dismiss any lingering menu layer so its inert overlay cannot intercept
  // the next dialog's controls.
  await page.keyboard.press('Escape')

  await userMenu.click()
  await accountMenu.getByRole('menuitem', { name: 'Help Center' }).click()
  const help = page.getByRole('dialog', { name: 'Help Center' })
  await expect(help).toBeVisible()
  await expect(help.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible()
  await expect(help.getByRole('heading', { name: 'Project links' })).toBeVisible()
  await expect(help.getByRole('link', { name: 'GitHub project' })).toBeVisible()
  await help.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(help).toBeHidden({ timeout: 20_000 })
  await page.keyboard.press('Escape')

  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ',', metaKey: true }))
  })
  const shortcutSettings = page.getByRole('dialog', { name: 'Settings' })
  await expect(shortcutSettings).toBeVisible()
  await expect(page).toHaveURL(/view=virtual/)
  await shortcutSettings.getByRole('button', { name: 'Close', exact: true }).click()

  await userMenu.click()
  await accountMenu.getByRole('menuitem', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await expect(page).toHaveURL(/view=virtual/)
  await expect(
    settings.locator('[data-slot="dialog-header"] .conventional-settings-logo')
  ).toBeVisible()
  const signInButton = settings.getByRole('button', { name: 'Sign in', exact: true })
  await expect(signInButton).toBeVisible()

  await settings.getByRole('tab', { name: 'Appearance' }).click()
  // The section is the appearance editor now (the simple Theme toggle it
  // replaced is gone, #425): its mode radiogroup is the control to expect.
  await expect(
    settings.getByRole('radiogroup', { name: 'Appearance mode', exact: true })
  ).toBeVisible()
  // The soundtrack moved out of Appearance (it is an input/notification
  // preference): it belongs to the Input & notifications tab now.
  await settings.getByRole('tab', { name: 'Input & notifications' }).click()
  await expect(settings.getByRole('button', { name: /music/i })).toBeVisible()
  await settings.getByRole('tab', { name: 'Account & app' }).click()
  await signInButton.click()
  await expect(page).toHaveURL(/\/auth\/sign-in\?returnTo=%2F$/)
  await expect(page.getByRole('heading', { name: 'Save your workspace' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Continue without an account' })).toBeVisible()
})

test('settings opens over chat without changing the current view', async ({ page }) => {
  await page.route('**/api/workspaces/bootstrap', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        activeWorkspace: workspace,
        principal: { temporary: true },
        workspaces: [workspace],
      },
    })
  })

  await page.goto('/?view=chat')
  const userMenu = page.getByRole('button', { name: 'User settings' })
  await expect(userMenu).toBeVisible({ timeout: 20_000 })
  await userMenu.click()
  await page.getByRole('menu').getByRole('menuitem', { name: 'Settings' }).click()

  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveURL(/view=chat/)
})

test('workspace search shortcut repeatedly focuses the disabled-chat App Library search', async ({
  page,
}) => {
  await page.route('**/api/workspaces/bootstrap', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        activeWorkspace: workspace,
        principal: { temporary: true },
        workspaces: [workspace],
      },
    })
  })
  await page.addInitScript(() => {
    localStorage.setItem(
      'adea:rail-preferences:v1',
      JSON.stringify({
        version: 1,
        order: ['virtual', 'chat', 'dev'],
        hidden: ['virtual', 'chat', 'dev'],
      })
    )
  })

  await page.goto('/?app=library')
  await expect(page.getByRole('heading', { name: 'App Library' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Enable Chat' })).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('searchbox', { name: 'Search apps' })).toBeFocused()
  await expect(page).toHaveURL(/app=library/)

  const search = page.getByRole('searchbox', { name: 'Search apps' })
  await page.getByRole('button', { name: 'Enable Chat' }).focus()
  await expect(page.getByRole('button', { name: 'Enable Chat' })).toBeFocused()
  await page.keyboard.press('Control+k')
  await expect(search).toBeFocused()

  const library = page.getByRole('main', { name: 'App Library' })
  await library.getByRole('button', { name: 'Enable Virtual' }).click()
  await library.getByRole('button', { name: 'Open Virtual' }).click()
  await expect(page.getByRole('status', { name: 'Virtual view unavailable' })).toBeVisible({
    timeout: 20_000,
  })
  await page
    .getByRole('navigation', { name: 'Global navigation' })
    .getByRole('button', { name: 'App Library', exact: true })
    .click()
  await expect(library).toBeVisible()
  await expect(search).not.toBeFocused()
})

test('desktop authentication ends on a clear browser success page', async ({ page }) => {
  const callback =
    'adea://auth/callback?code=one-time-code&nonce=nonce-value-12345&state=state-value-12345'
  const fragment = new URLSearchParams({ callback }).toString()
  await page.route('adea://**', (route) => route.abort())

  await page.goto(`/auth/desktop/complete#${fragment}`, { waitUntil: 'commit' })

  await expect(page.getByRole('heading', { name: 'You’re all set' })).toBeVisible()
  await expect(page.getByText('You can close this tab')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open Adea' })).toBeVisible()
  await expect(page).toHaveURL(/\/auth\/desktop\/complete$/)
})
