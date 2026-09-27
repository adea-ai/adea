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
  await expect(page.getByRole('button', { name: 'Open edit', exact: true })).toBeEnabled()
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
