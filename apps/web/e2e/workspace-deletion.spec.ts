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

test('confirmation must match; Cancel resets it and Escape keeps it reviewable; default mark is a box', async ({
  page,
}) => {
  const settings = await openFixture(page)
  await expect(settings.locator('[data-workspace-icon="box"]')).toHaveCount(2)
  await settings.getByRole('button', { name: 'Delete workspace', exact: true }).click()
  const confirmation = page.getByRole('alertdialog', { name: 'Delete Settings harness?' })
  const input = confirmation.getByRole('textbox', { name: 'Type Settings harness to confirm' })
  await expect(
    confirmation.getByRole('button', { name: 'Permanently delete workspace' })
  ).toBeDisabled()
  await input.fill('wrong')
  await expect(
    confirmation.getByRole('button', { name: 'Permanently delete workspace' })
  ).toBeDisabled()
  await input.fill('Settings harness')
  await expect(
    confirmation.getByRole('button', { name: 'Permanently delete workspace' })
  ).toBeEnabled()
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await settings.getByRole('button', { name: 'Delete workspace', exact: true }).click()
  await expect(input).toHaveValue('')
  await input.press('Escape')
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(confirmation).not.toBeVisible()
  await expect(
    settings.getByRole('button', { name: 'Delete workspace', exact: true })
  ).toBeFocused()
  await expect(page.locator('#harness-root')).not.toHaveAttribute('data-delete-calls')
  await settings.getByRole('textbox', { name: 'Workspace emoji' }).fill('📦')
  await settings.getByRole('textbox', { name: 'Workspace emoji' }).blur()
  await expect(settings.locator('[data-workspace-icon="box"]')).toHaveCount(0)
  await settings.getByRole('button', { name: 'Use workspace icon', exact: true }).click()
  await expect(settings.locator('[data-workspace-icon="box"]')).toHaveCount(2)
})

test('failed deletion stays reviewable and retries without dismissing prematurely', async ({
  page,
}) => {
  const settings = await openFixture(page, 'data-delete-failure')
  await settings.getByRole('button', { name: 'Delete workspace', exact: true }).click()
  const confirmation = page.getByRole('alertdialog')
  await confirmation.getByRole('textbox').fill('Settings harness')
  await confirmation.getByRole('button', { name: 'Permanently delete workspace' }).click()
  await expect(confirmation.getByRole('alert')).toContainText('Workspace could not be deleted')
  await confirmation.getByRole('button', { name: 'Permanently delete workspace' }).click()
  await expect(settings).not.toBeVisible()
  await expect(page.locator('#harness-root')).toHaveAttribute('data-delete-calls', '2')
})

test('pending deletion cannot be submitted twice or dismissed', async ({ page }) => {
  const settings = await openFixture(page, 'data-delete-delayed')
  await settings.getByRole('button', { name: 'Delete workspace', exact: true }).click()
  const confirmation = page.getByRole('alertdialog')
  await confirmation.getByRole('textbox').fill('Settings harness')
  await confirmation.getByRole('button', { name: 'Permanently delete workspace' }).click()
  await expect(confirmation.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
  await confirmation.press('Escape')
  await expect(confirmation).toBeVisible()
  await expect(page.locator('#harness-root')).toHaveAttribute('data-delete-calls', '1')
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:delete-complete')))
  await expect(settings).not.toBeVisible()
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
