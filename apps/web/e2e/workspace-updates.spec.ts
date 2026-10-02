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
  const trigger = page.getByRole('button', { name: 'User settings' })
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Updates', exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('a pending update marks the account trigger and the Updates item', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'User settings', exact: true })

  // While no update is pending, the trigger keeps its plain name and no dot.
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Updates', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Version & updates', exact: true })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toHaveAccessibleName('User settings')
  await expect(page.locator('.global-rail__account-trigger .global-rail__update-dot')).toHaveCount(
    0
  )

  // An available update reaches the badge through the dialog's own check —
  // the adapter mirror is the only writer of the shared pending state. The
  // pending trigger carries a new accessible name, so re-acquire it by that.
  await page.getByRole('button', { name: 'Make update available' }).click()
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Updates', exact: true }).click()
  await expect(dialog.getByText('Version 9.9.9 is ready', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  const pendingTrigger = page.getByRole('button', {
    name: 'User settings, update available',
    exact: true,
  })
  await expect(pendingTrigger).toBeVisible()
  await expect(page.locator('.global-rail__account-trigger .global-rail__update-dot')).toHaveCount(
    1
  )

  await pendingTrigger.click()
  const updatesItem = page.getByRole('menuitem', { name: 'Updates, update available' })
  await expect(updatesItem).toBeVisible()
  await expect(updatesItem.locator('.global-rail__update-dot')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)

  // When the updater reports current again, the badge clears everywhere. The
  // names flip only once the dialog re-checks, so drive this pass through
  // name-agnostic locators.
  await page.getByRole('button', { name: 'Make update current' }).click()
  await page.locator('.global-rail__account-trigger').click()
  await page.getByRole('menuitem', { name: /Updates/ }).click()
  await expect(page.getByText('Adea is up to date.', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('button', { name: 'User settings', exact: true })
  ).toHaveAccessibleName('User settings')
  await expect(page.locator('.global-rail__account-trigger .global-rail__update-dot')).toHaveCount(
    0
  )
})

test('an in-flight download visibly progresses and completes without regressing', async ({
  page,
}) => {
  const trigger = page.getByRole('button', { name: 'User settings', exact: true })
  await page.getByRole('button', { name: 'Make update available' }).click()
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Updates', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Version & updates', exact: true })
  await expect(dialog.getByText('Version 9.9.9 is ready', { exact: true })).toBeVisible()

  await dialog.getByRole('button', { name: 'Install and restart' }).click()
  const progress = dialog.getByRole('progressbar', { name: 'Downloading update' })
  await expect(progress).toBeVisible()

  // The shell answers `downloading` with zero bytes for its fast downloads;
  // the adapter's synthetic curve must visibly move the bar anyway, and never
  // move it backwards between polls.
  const readValue = () =>
    page.evaluate(() => {
      const bar = document.querySelector('[role="progressbar"][aria-label="Downloading update"]')
      const raw = bar?.getAttribute('aria-valuenow')
      return raw === null ? null : Number.parseInt(raw, 10)
    })
  await expect.poll(readValue, { timeout: 10_000, intervals: [500] }).toBeGreaterThan(0)
  let previous = await readValue()
  for (let sample = 0; sample < 3; sample += 1) {
    await page.waitForTimeout(700)
    const current = await readValue()
    expect(current).toBeGreaterThanOrEqual(previous ?? 0)
    previous = current
  }

  await page.evaluate(() => {
    ;(
      window as unknown as { updatesHarness?: { settleInstall(): void } }
    ).updatesHarness?.settleInstall()
  })
  await expect(
    dialog.getByText('Restart Adea to finish the update.', { exact: true })
  ).toBeVisible()
  await expect(progress).toHaveCount(0)
})
