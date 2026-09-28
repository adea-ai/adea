import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test.beforeEach(async ({ page }) => {
  const path = '/__workspace-form'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  await page.evaluate(() => {
    const prior = document.createElement('div')
    prior.id = 'preexisting-inert'
    prior.setAttribute('inert', '')
    document.body.append(prior)
  })
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-form-harness-app.tsx')
  )
})

test('room form keeps native validation, submitted data, retry and async close cleanup', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Open room', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create Room', exact: true })
  await expect(page.locator('#harness-root')).not.toHaveAttribute('aria-hidden', 'true')
  await dialog.getByRole('button', { name: 'Create Room', exact: true }).click()
  await expect(page.getByLabel('Requests')).toHaveText('[]')
  await dialog.getByLabel('Room name', { exact: true }).fill('New room')
  await dialog.getByLabel('Function key', { exact: true }).fill('study')
  await dialog.getByRole('button', { name: 'Create Room', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText(
    'Room could not be created. Check the fields and retry.'
  )
  await expect(page.getByLabel('Requests')).toHaveText(
    '[{"functionKey":"study","name":"New room"}]'
  )
  await expect(dialog.getByLabel('Room name', { exact: true })).toHaveValue('New room')
  // Change the scripted service result without interacting with inert background UI.
  await page.evaluate(() => (document.querySelector('#allow-success') as HTMLButtonElement).click())
  await dialog.getByRole('button', { name: 'Create Room', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('#harness-root')).not.toHaveAttribute('inert', '')
  await expect(page.locator('#harness-root')).not.toHaveAttribute('aria-hidden', 'true')
  await expect(page.locator('#preexisting-inert')).toHaveAttribute('inert', '')
  await expect(page.getByRole('button', { name: 'Open edit', exact: true })).toBeEnabled()
})

test('shared room modal dismisses and reopens without stale background containment', async ({
  page,
}) => {
  const opener = page.getByRole('button', { name: 'Open room', exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'Create Room', exact: true })
  await expect(dialog).toBeVisible()
  await expect(page.locator('#harness-root')).toHaveAttribute('inert', '')
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('#harness-root')).not.toHaveAttribute('inert', '')
  await expect(page.locator('#preexisting-inert')).toHaveAttribute('inert', '')
  await expect(opener).toBeFocused()
  await opener.click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('#harness-root')).not.toHaveAttribute('inert', '')
  await expect(page.locator('#harness-root')).not.toHaveAttribute('aria-hidden', 'true')
  await expect(page.locator('#preexisting-inert')).toHaveAttribute('inert', '')
  await expect(opener).toBeFocused()
})

test('shared room modal keeps its content and close action contained in a narrow viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.getByRole('button', { name: 'Open room', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create Room', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveCSS('overflow', 'auto')
  const positioner = dialog.locator('xpath=..')
  await expect(positioner).toHaveCSS('position', 'fixed')
  await expect(positioner).toHaveCSS('display', 'grid')
  await expect(positioner).toHaveCSS('padding', '16px')
  const bounds = await dialog.boundingBox()
  expect(bounds).not.toBeNull()
  expect(Math.abs(bounds!.x + bounds!.width / 2 - 160)).toBeLessThanOrEqual(1)
  expect(Math.abs(bounds!.y + bounds!.height / 2 - 284)).toBeLessThanOrEqual(1)
  expect(bounds!.x).toBeGreaterThanOrEqual(16)
  expect(bounds!.y).toBeGreaterThanOrEqual(16)
  expect(bounds!.width).toBeLessThanOrEqual(288)
  expect(bounds!.height).toBeLessThanOrEqual(536)
  const close = dialog.getByRole('button', { name: 'Close', exact: true })
  await expect(close).toBeInViewport()
  await close.click()
  await expect(dialog).toHaveCount(0)
})

test('edit, rename and group forms retain initial values and native label associations', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Allow success', exact: true }).click()
  await page.getByRole('button', { name: 'Open edit', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Edit Study', exact: true })
  await expect(dialog.getByLabel('Room name', { exact: true })).toHaveValue('Study')
  await dialog.getByLabel('Room name', { exact: true }).fill('Renamed room')
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Open rename', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Rename conversation', exact: true })
  await expect(dialog.getByLabel('Conversation name')).toHaveValue('Original')
  await dialog.getByLabel('Conversation name').fill('New title')
  await dialog.getByRole('button', { name: 'Save title', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Open group', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'New group conversation', exact: true })
  await dialog.getByLabel('Conversation name').fill('Team')
  await dialog.getByRole('button', { name: 'Create conversation', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByLabel('Requests')).toHaveText(
    '[{"functionKey":"study","name":"Renamed room"},"New title","Team"]'
  )
})

test('about dialog preserves its accessible name and product identity with a shared hidden header', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Open about', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'About Adea', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Adea', exact: true })).toBeVisible()
  await expect(dialog.getByText('Version 0.61.7', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'View source' })).toHaveAttribute(
    'href',
    'https://github.com/adea-ai/adea'
  )
  const header = dialog.locator('[data-slot="dialog-header"]')
  await expect(header).toHaveCSS('position', 'absolute')
  await expect(header).toHaveCSS('width', '1px')
  await expect(header).toHaveCSS('height', '1px')
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('#harness-root')).not.toHaveAttribute('inert', '')
  await expect(page.locator('#preexisting-inert')).toHaveAttribute('inert', '')
})
