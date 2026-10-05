// The permissions page in the web lane (#667, from the #471 record audit).
//
// The unit suite (`apps/desktop/tests/shell-permissions.test.ts`) pins the probe
// classifications; this drives the *surface*: the section opens, every row
// states a typed status rather than a guess, and asking the lane to do
// something it cannot do is reported to the user instead of failing silently. TCC itself is not drivable from a browser, so the browser lane is
// the truthful-degradation half — which is exactly the half the audit found
// untested.
import { expect, test, type Page } from '@playwright/test'

async function openPermissions(page: Page) {
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const pane = settings.getByRole('region', { name: 'macOS permissions' })
  await expect(async () => {
    // Idempotent on purpose (a test may ask again while the section is up), and
    // reached through the UI rather than the hash: the section is read from the
    // hash on mount, so a hash navigation from an already-loaded page is not a
    // path the app promises to honour — and re-navigating to the *same* URL
    // (what a naive retry does) is a no-op, not a reload.
    if (await pane.isVisible().catch(() => false)) return
    if (!(await settings.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: 'User settings' }).click()
      await page.getByRole('menuitem', { name: 'Settings' }).click()
    }
    await settings.getByRole('tab', { name: 'Permissions' }).click()
    await expect(pane).toBeVisible()
  }).toPass({ timeout: 30_000 })
  return pane
}

async function setAppearanceFontRoles(page: Page) {
  const popup = page.getByRole('dialog', { name: 'Appearance', exact: true })
  await expect(async () => {
    if (await popup.isVisible().catch(() => false)) return
    await page.getByRole('button', { name: 'Appearance settings', exact: true }).click()
    await expect(popup).toBeVisible()
  }).toPass({ timeout: 60_000 })

  for (const [role, family, size] of [
    ['UI', 'Space Grotesk', '28'],
    ['Content', 'Geist', '18'],
    ['Code', 'JetBrains Mono', '16'],
  ] as const) {
    await popup.getByRole('button', { name: `${role} font family`, exact: true }).click()
    const menu = page.getByRole('menu', { name: `${role} font family`, exact: true })
    await menu.getByRole('menuitemradio', { name: family, exact: true }).click()
    await expect(menu).toBeHidden()
    const input = popup.getByRole('spinbutton', {
      name: `${role} font size in pixels`,
    })
    await input.fill(size)
    await input.press('Tab')
    await expect
      .poll(() =>
        page.evaluate(
          (axis) => document.documentElement.style.getPropertyValue(`--font-${axis}-size`),
          role.toLowerCase()
        )
      )
      .toBe(`${size}px`)
  }

  await popup.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(popup).toBeHidden()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?view=chat')
  await expect(page.getByRole('main')).toBeVisible({ timeout: 20_000 })
})

test('the unavailable resources refresh action explains its disabled state', async ({ page }) => {
  await page.getByRole('button', { name: 'Runtime resources', exact: true }).click()
  const resources = page.getByRole('region', { name: 'Runtime resources' })
  await expect(resources.getByText('Runtime unavailable', { exact: true })).toBeVisible()
  const refresh = resources.getByRole('button', { name: 'Refresh resources', exact: true })
  await expect(refresh).toBeDisabled()
  await refresh.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Connect a runtime to refresh resources')
  await refresh.focus()
  await refresh.press('Enter')
  await expect(resources.getByText('Runtime unavailable', { exact: true })).toBeVisible()
})

test('the permissions section is reachable and states typed statuses, never guesses', async ({
  page,
}) => {
  const pane = await openPermissions(page)

  // The refresh affordance is always there; the notice is not a standing
  // element — it is the bridge-unreachable banner, so asserting it here would
  // have been asserting an accident of one lane's service.
  await expect(pane.getByRole('button', { name: /refresh|check/i }).first()).toBeVisible()

  // Rows exist, each with a status chip and the reason it cannot be checked.
  await expect(pane.getByRole('group').first()).toBeVisible()
  const statuses = pane.locator('.dev-permissions__status')
  await expect(statuses.first()).toBeVisible()
  expect(await statuses.count()).toBeGreaterThan(1)
  await expect(pane.getByText('Cannot check').first()).toBeVisible()
  await expect(pane.getByText(/no probe for this permission/i).first()).toBeVisible()
})

test('every permission row offers the System Settings affordance', async ({ page }) => {
  const pane = await openPermissions(page)

  const actions = pane.getByRole('button', { name: 'Open System Settings' })
  // One per row that is not granted — in this lane, all of them.
  expect(await actions.count()).toBeGreaterThan(1)
  await expect(actions.first()).toBeEnabled()
})

test('asking a lane that cannot open System Settings reports it instead of failing silently', async ({
  page,
}) => {
  const pane = await openPermissions(page)

  // The browser lane injects no native bridge, so the service's openSettings
  // rejects; the pane must surface that as an announcement, never as a no-op.
  await pane.getByRole('button', { name: 'Open System Settings' }).first().click()

  await expect(pane.getByRole('status')).toContainText(
    /could not open system settings for .* from this lane/i
  )
})

test('appearance font roles change computed typography in Resources and Permissions', async ({
  page,
}) => {
  await setAppearanceFontRoles(page)

  await page.getByRole('button', { name: 'Runtime resources', exact: true }).click()
  const resources = page.getByRole('region', { name: 'Runtime resources' })
  await expect(resources).toBeVisible()
  const resourceUi = resources.locator('.dev-resources__title')
  const resourceContent = resources
    .locator('.dev-resources__note, .dev-resources__unavailable')
    .first()
  await expect(resourceContent).toBeVisible()
  await expect(resourceUi).toHaveCSS('font-size', '32px')
  await expect(resourceUi).toHaveCSS('font-family', /Space Grotesk/)
  await expect(resourceContent).toHaveCSS('font-size', '18px')
  await expect(resourceContent).toHaveCSS('font-family', /Geist/)
  // Fonts are loaded on demand: check the actual UI/content consumers after
  // opening Resources. Real terminal and browser tests cover code consumers.
  await expect
    .poll(() =>
      page.evaluate(() =>
        ['Space Grotesk', 'Geist'].every((family) =>
          [...document.fonts].some(
            (face) => face.family.includes(family) && face.status === 'loaded'
          )
        )
      )
    )
    .toBe(true)
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--font-code-size').trim()
      )
    )
    .toBe('16px')

  // The shared sheet is modal, so the top-bar trigger no longer toggles it
  // closed — dismissal is the sheet's own close affordance.
  await page.getByRole('button', { name: 'Close runtime resources' }).click()
  const permissions = await openPermissions(page)
  const permissionTitle = permissions.locator('.dev-permissions__title').first()
  const permissionPurpose = permissions.locator('.dev-permissions__purpose').first()
  await expect(permissionTitle).toHaveCSS('font-size', '28px')
  await expect(permissionTitle).toHaveCSS('font-family', /Space Grotesk/)
  await expect(permissionPurpose).toHaveCSS('font-size', '18px')
  await expect(permissionPurpose).toHaveCSS('font-family', /Geist/)
})
