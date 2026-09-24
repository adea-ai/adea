// The permissions page in the web lane (#667, from the #471 record audit).
//
// The unit suite (`apps/desktop/tests/shell-permissions.test.ts`) pins the probe
// classifications; this drives the *surface*: the deep link lands on the
// section, every row states a typed status rather than a guess, and asking the
// lane to do something it cannot do is reported to the user instead of failing
// silently. TCC itself is not drivable from a browser, so the browser lane is
// the truthful-degradation half — which is exactly the half the audit found
// untested.
import { expect, test, type Page } from '@playwright/test'

async function openPermissions(page: Page) {
  await page.goto('/#settings/permissions')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const pane = settings.getByRole('region', { name: 'macOS permissions' })
  await expect(async () => {
    // Idempotent: the deep link is read on mount, so the first load is the one
    // that opens the section.
    if (await pane.isVisible().catch(() => false)) return
    await page.goto('/#settings/permissions')
    await expect(pane).toBeVisible()
  }).toPass({ timeout: 30_000 })
  return pane
}

test('the permissions section is reachable and states typed statuses, never guesses', async ({
  page,
}) => {
  const pane = await openPermissions(page)

  // The standing note is part of the contract: nothing below it is inferred.
  await expect(pane.getByRole('note')).toContainText('No status below is a guess')
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
