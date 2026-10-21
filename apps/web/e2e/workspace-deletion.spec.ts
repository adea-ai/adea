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
  await page.goto(`${path}#settings/workspace-general`)
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-settings-harness-app.tsx')
  )
  return page.getByRole('dialog', { name: 'Settings', exact: true })
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
  await expect(settings.locator('[data-workspace-icon="box"] svg')).toHaveCount(2)
  await settings.getByRole('textbox', { name: 'Workspace emoji' }).fill('📦')
  await settings.getByRole('textbox', { name: 'Workspace emoji' }).blur()
  await expect(settings.locator('[data-workspace-icon="box"] svg')).toHaveCount(0)
  await settings.getByRole('button', { name: 'Use workspace icon', exact: true }).click()
  await expect(settings.locator('[data-workspace-icon="box"] svg')).toHaveCount(2)
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
  await expect(settings.locator('[data-workspace-icon="home"] svg')).toHaveCount(2)
  await expect(settings.getByRole('button', { name: 'Delete workspace', exact: true })).toHaveCount(
    0
  )
  await expect(settings).toContainText(
    'Home can’t be archived or deleted. It stays with your account'
  )
  const name = settings.getByRole('textbox', { name: 'Workspace name' })
  await name.fill('Personal studio')
  await name.blur()
  const renamed = page.getByRole('dialog', {
    name: 'Settings',
    exact: true,
  })
  await renamed.getByRole('button', { name: /^Workspace icon:/ }).click()
  await page.getByRole('radio', { name: 'Rocket', exact: true }).check({ force: true })
  await expect(renamed.locator('[data-workspace-icon="home"] svg')).toHaveCount(0)
  await expect(renamed.getByRole('button', { name: 'Delete workspace', exact: true })).toHaveCount(
    0
  )
  await renamed.getByRole('button', { name: /^Workspace icon:/ }).click()
  await page.getByRole('radio', { name: /^Home/ }).check({ force: true })
  await expect(renamed.locator('[data-workspace-icon="home"] svg')).toHaveCount(2)
  await expect(page.locator('#harness-root')).not.toHaveAttribute('data-delete-calls')
})
