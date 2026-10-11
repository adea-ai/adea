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
          for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowDown')
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
  const trigger = page.getByRole('button', { name: 'User settings', exact: true })
  await trigger.click()
  await expect(page.getByRole('menuitem', { name: 'Updates', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('loads the complete browser changelog on open and reuses it after reopening', async ({
  page,
}) => {
  const changelogRequests: string[] = []
  page.on('request', (request) => {
    if (/CHANGELOG/i.test(request.url())) changelogRequests.push(request.url())
  })

  const trigger = page.getByRole('button', { name: 'User settings', exact: true })
  await expect.poll(() => changelogRequests).toHaveLength(0)

  for (let cycle = 0; cycle < 2; cycle++) {
    await trigger.click()
    await page.getByRole('menuitem', { name: 'Updates', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Version & updates', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('region', { name: 'Installed changelog' })).toContainText('0.2.0')
    expect(changelogRequests).toHaveLength(1)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  }
})

test('shows a release-history fallback and retries a failed browser changelog load', async ({
  page,
}) => {
  let requests = 0
  await page.route(/CHANGELOG/i, async (route) => {
    requests += 1
    if (requests === 1)
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'unavailable' })
    else await route.continue()
  })

  const trigger = page.getByRole('button', { name: 'User settings', exact: true })
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Updates', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Version & updates', exact: true })
  const history = dialog.getByRole('region', { name: 'Installed changelog' })
  await expect(history).toContainText('Could not load the installed history.')
  await expect(history).toContainText('https://github.com/adea-ai/adea/releases')
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  await trigger.click()
  await page.getByRole('menuitem', { name: 'Updates', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Version & updates', exact: true })
  await expect(dialog.getByRole('region', { name: 'Installed changelog' })).toContainText('0.2.0')
  expect(requests).toBe(2)
})
