import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

test.use({ headless: true })

const formRequests = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
  const requests: string[] = []
  formRequests.set(page, requests)
  page.on('request', (request) => {
    if (request.url().includes('/sidebar/add-project-form.tsx')) requests.push(request.url())
  })
  await page.route('**/__dev-add-project', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto('/__dev-add-project')
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/dev-add-project-harness-app.tsx')
  )
  await expect(page.getByTestId('ready')).toHaveText('ready')
})

test('collapsed Add Project leaves its form and runtime requests unloaded', async ({ page }) => {
  await expect(page.locator('details')).not.toHaveAttribute('open')
  await expect(page.getByTestId('operations')).toHaveText('[]')
  await expect(
    page.getByRole('combobox', { name: 'Authorized root to scan', includeHidden: true })
  ).toHaveCount(0)
  expect(formRequests.get(page)).toEqual([])
})

test('first open loads once and collapse preserves scan, confirmation, and group draft', async ({
  page,
}) => {
  await page.locator('summary').click()
  const root = page.getByRole('combobox', { name: 'Authorized root to scan', includeHidden: true })
  await expect(root).toBeVisible()
  expect(formRequests.get(page)).toHaveLength(1)
  await expect(page.getByTestId('operations')).toHaveText(
    '["dev.project.bookmarks","dev.group.list"]'
  )
  await root.selectOption('root')
  const confirmation = page.getByRole('checkbox', { name: 'Fixture projectbun' })
  await confirmation.focus()
  await confirmation.press('Space')
  await expect(confirmation).toBeChecked()
  const groupName = page.getByRole('textbox', { name: 'New group name' })
  await groupName.fill('Saved draft')
  await page.locator('summary').click()
  await expect(root).not.toBeVisible()
  await expect(root).toHaveCount(1)
  await page.locator('summary').click()
  await expect(root).toHaveValue('root')
  await expect(confirmation).toBeChecked()
  await expect(groupName).toHaveValue('Saved draft')
  expect(formRequests.get(page)).toHaveLength(1)
  await expect(page.getByTestId('operations')).toHaveText(
    '["dev.project.bookmarks","dev.group.list","dev.project.scan"]'
  )
  await page.getByRole('button', { name: 'Import confirmed packages' }).click()
  await expect(page.getByTestId('announcement')).toHaveText('Imported 1 project.')
  await expect(page.getByTestId('imports')).toHaveText('1')
  await expect(page.getByTestId('operations')).toHaveText(
    '["dev.project.bookmarks","dev.group.list","dev.project.scan","dev.group.create","dev.project.import"]'
  )
})
