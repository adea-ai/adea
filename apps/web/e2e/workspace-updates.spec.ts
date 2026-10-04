import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

const harnessModule =
  '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-updates-harness-app.tsx')

async function mountWorkspaceUpdatesHarness(page: import('@playwright/test').Page, query = '') {
  await page.goto(`/__workspace-updates${query}`)
  await page.evaluate(async (url) => {
    await import(url)
  }, harnessModule)
}

test.beforeEach(async ({ page }) => {
  await page.route('**/__workspace-updates**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await mountWorkspaceUpdatesHarness(page)
})

test('keeps the boot badge seed while delaying the visual dialog until first open', async ({
  page,
}) => {
  const sharedDialogRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (/\/components\/composites\/update-dialog\/update-dialog\.(?:tsx|js)$/.test(pathname))
      sharedDialogRequests.push(pathname)
  })
  await mountWorkspaceUpdatesHarness(page, '?initial=available')

  const statusReads = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            updatesHarness?: { statusReads(): number }
          }
        ).updatesHarness?.statusReads() ?? -1
    )
  const sharedDialogModuleLoads = () => sharedDialogRequests.length

  await expect.poll(statusReads).toBe(1)
  const trigger = page.getByRole('button', {
    name: 'User settings, update available',
    exact: true,
  })
  await expect(trigger).toBeVisible()
  await expect(page.locator('.global-rail__account-trigger .global-rail__update-dot')).toHaveCount(
    1
  )
  await expect.poll(sharedDialogModuleLoads).toBe(0)

  const openUpdates = async () => {
    await trigger.click()
    await page.getByRole('menuitem', { name: 'Updates, update available', exact: true }).click()
    return page.getByRole('dialog', { name: 'Version & updates', exact: true })
  }
  const dialog = await openUpdates()
  await expect(dialog).toBeVisible()
  await expect.poll(sharedDialogModuleLoads).toBe(1)
  await expect.poll(statusReads).toBe(2)

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  const reopenedDialog = await openUpdates()
  await expect(reopenedDialog).toBeVisible()
  await expect.poll(sharedDialogModuleLoads).toBe(1)
  await expect.poll(statusReads).toBe(3)
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

test('the update dialog persists channels and refreshes offers after a channel change', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Enable channel update fixtures' }).click()
  const trigger = page.getByRole('button', { name: /^User settings(?:, update available)?$/ })
  const openUpdates = async () => {
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Updates(?:, update available)?$/ }).click()
    return page.getByRole('dialog', { name: 'Version & updates', exact: true })
  }
  const dialog = await openUpdates()
  const channel = dialog.getByRole('combobox', { name: 'Update channel', exact: true })
  await expect(channel).toHaveValue('stable')
  await expect(dialog.getByText('Version 9.9.9 is ready', { exact: true })).toBeVisible()

  await channel.selectOption('pre-release')
  await expect(channel).toHaveValue('pre-release')
  await expect(dialog.getByText('Adea is up to date.', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Install and restart' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  const reopenedPreRelease = await openUpdates()
  const reopenedChannel = reopenedPreRelease.getByRole('combobox', {
    name: 'Update channel',
    exact: true,
  })
  await expect(reopenedChannel).toHaveValue('pre-release')
  await reopenedChannel.selectOption('dev')
  await expect(
    reopenedPreRelease.getByText('Version 9.9.9-dev.17 is ready', { exact: true })
  ).toBeVisible()
  await expect(
    reopenedPreRelease.getByRole('button', { name: 'Install and restart' })
  ).toBeVisible()

  await reopenedPreRelease.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(reopenedPreRelease).toHaveCount(0)
  const reopenedDev = await openUpdates()
  await expect(
    reopenedDev.getByRole('combobox', { name: 'Update channel', exact: true })
  ).toHaveValue('dev')
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
