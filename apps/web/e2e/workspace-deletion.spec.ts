import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

async function openFixture(page: Page, attribute?: string) {
  const path = '/__workspace-deletion'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body><div id="harness-root" ${attribute ?? ''}></div></body></html>`,
    })
  )
  await page.goto(`${path}#workspace-settings/general`)
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-settings-harness-app.tsx')
  )
  return page.getByRole('dialog', { name: 'Settings harness workspace settings', exact: true })
}

test('active deletion is unavailable and cannot invoke the mutation; default mark is a box', async ({
  page,
}) => {
  const settings = await openFixture(page)
  const button = settings.getByRole('button', { name: 'Delete workspace', exact: true })
  await expect(button).toBeDisabled()
  await expect(settings).toContainText('Permanent deletion is currently unavailable')
  await expect(settings).toContainText('Your workspace and its data will be kept')
  await button.dispatchEvent('click')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(page.locator('#harness-root')).not.toHaveAttribute('data-delete-calls')
  await expect(settings.locator('[data-workspace-icon="box"]')).toHaveCount(2)
  await settings.getByRole('textbox', { name: 'Workspace emoji' }).fill('📦')
  await settings.getByRole('textbox', { name: 'Workspace emoji' }).blur()
  await expect(settings.locator('[data-workspace-icon="box"]')).toHaveCount(0)
  await settings.getByRole('button', { name: 'Use workspace icon', exact: true }).click()
  await expect(settings.locator('[data-workspace-icon="box"]')).toHaveCount(2)
})

test('an interrupted pending workspace keeps its data and cannot submit deletion', async ({
  page,
}) => {
  const settings = await openFixture(page, 'data-delete-pending')
  await expect(
    settings.getByRole('button', { name: 'Delete workspace', exact: true })
  ).toBeDisabled()
  await expect(settings).toContainText('Deletion is pending')
  await expect(settings).toContainText('Permanent deletion is currently unavailable')
  await expect(page.locator('#harness-root')).not.toHaveAttribute('data-delete-calls')
})

test('a non-owner has no destructive settings action', async ({ page }) => {
  const settings = await openFixture(page, 'data-read-only')
  await expect(settings.getByRole('button', { name: 'Delete workspace', exact: true })).toHaveCount(
    0
  )
})

test('personal Home remains protected after renaming and changing its icon', async ({ page }) => {
  const settings = await openFixture(page, 'data-personal')
  await expect(settings.locator('[data-workspace-icon="home"]')).toHaveCount(2)
  await expect(settings.getByRole('button', { name: 'Delete workspace', exact: true })).toHaveCount(
    0
  )
  await expect(settings).toContainText('Your personal workspace stays with your account')
  const name = settings.getByRole('textbox', { name: 'Workspace name' })
  await name.fill('Personal studio')
  await name.blur()
  const renamed = page.getByRole('dialog', {
    name: 'Personal studio workspace settings',
    exact: true,
  })
  await renamed.getByRole('textbox', { name: 'Workspace emoji' }).fill('🌿')
  await renamed.getByRole('textbox', { name: 'Workspace emoji' }).blur()
  await expect(renamed.locator('[data-workspace-icon="home"]')).toHaveCount(0)
  await expect(renamed.getByRole('button', { name: 'Delete workspace', exact: true })).toHaveCount(
    0
  )
  await renamed.getByRole('button', { name: 'Use workspace icon', exact: true }).click()
  await expect(renamed.locator('[data-workspace-icon="home"]')).toHaveCount(2)
  await expect(page.locator('#harness-root')).not.toHaveAttribute('data-delete-calls')
})

test('personal and additional workspaces move in the same list and a failed order stays reviewable', async ({
  page,
}) => {
  const settings = await openFixture(page, 'data-personal data-reorder-failure')
  await expect(settings.getByRole('button', { name: 'Move up', exact: true })).toBeDisabled()
  await settings.getByRole('button', { name: 'Move down', exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText('Workspace order could not be saved')
  await expect(settings).toContainText('Position 1 of 2')
  await settings.getByRole('button', { name: 'Move down', exact: true }).click()
  await expect(settings).toContainText('Position 2 of 2')
  await expect(settings.getByRole('button', { name: 'Move down', exact: true })).toBeDisabled()
  await settings.getByRole('button', { name: 'Move up', exact: true }).click()
  await expect(settings).toContainText('Position 1 of 2')
  await expect(page.locator('#harness-root')).toHaveAttribute(
    'data-order',
    '["workspace-settings-e2e","settings-sibling"]'
  )
})
