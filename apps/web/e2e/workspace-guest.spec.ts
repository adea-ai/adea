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

const workspace = {
  id: 'workspace-guest-e2e',
  name: 'My Agent HQ',
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

  await page.goto('/?view=spatial')
  const userMenu = page.getByRole('button', { name: 'User settings' })
  await expect(userMenu).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Open user menu for Sign in' })).toHaveCount(0)
  await expect(page.locator('.workspace-statusbar')).toHaveCount(0)
  await expect(page.locator('.workspace-topbar')).toHaveCount(0)

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
    expect(layout).toEqual({ railWidth: 64, surfaceOffset: 64 })
  }

  await userMenu.click()
  const accountMenu = page.getByRole('menu')
  await expect(accountMenu.getByRole('menuitem', { name: 'Get Grok Bot for iOS' })).toBeDisabled()
  await expect(accountMenu.getByRole('menuitem', { name: 'Help Center' })).toBeDisabled()
  await expect(accountMenu.getByRole('menuitem', { name: 'Send Feedback' })).toBeDisabled()
  await accountMenu.getByRole('menuitem', { name: 'About' }).click()
  await expect(page.getByRole('dialog', { name: 'About Agent HQ' })).toBeVisible()
  await page.getByRole('button', { name: 'Close dialog' }).click()

  await userMenu.click()
  await accountMenu.getByRole('menuitem', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  const signInButton = settings.getByRole('button', { name: 'Sign in', exact: true })
  await expect(signInButton).toBeVisible()

  await settings.getByRole('tab', { name: 'Appearance' }).click()
  await expect(page.getByRole('radiogroup', { name: 'Theme' })).toBeVisible()
  const musicButton = settings.getByRole('button', { name: /music/i })
  await expect(musicButton).toBeVisible()
  await settings.getByRole('tab', { name: 'Account & app' }).click()
  await signInButton.click()
  await expect(page).toHaveURL(/\/auth\/sign-in\?returnTo=%2F$/)
  await expect(page.getByRole('heading', { name: 'Save your workspace' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Continue without an account' })).toBeVisible()
})

test('desktop authentication ends on a clear browser success page', async ({ page }) => {
  const callback =
    'agent-hq://auth/callback?code=one-time-code&nonce=nonce-value-12345&state=state-value-12345'
  const fragment = new URLSearchParams({ callback }).toString()
  await page.route('agent-hq://**', (route) => route.abort())

  await page.goto(`/auth/desktop/complete#${fragment}`, { waitUntil: 'commit' })

  await expect(page.getByRole('heading', { name: 'You’re all set' })).toBeVisible()
  await expect(page.getByText('You can close this tab')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open Agent HQ' })).toBeVisible()
  await expect(page).toHaveURL(/\/auth\/desktop\/complete$/)
})
