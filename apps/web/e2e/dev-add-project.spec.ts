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

const openDialog = (page: Page) =>
  page.getByRole('button', { name: 'Add repository…', exact: true }).click()

test('an unopened Add repository leaves its form and runtime requests unloaded', async ({
  page,
}) => {
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('operations')).toHaveText('[]')
  await expect(
    page.getByRole('combobox', { name: 'Authorized root to scan', includeHidden: true })
  ).toHaveCount(0)
  expect(formRequests.get(page)).toEqual([])
})

test('the dialog loads once and imports the confirmed entry under the project id', async ({
  page,
}) => {
  await openDialog(page)
  const dialog = page.getByRole('dialog', { name: 'Add a repository to Fixture project' })
  await expect(dialog).toBeVisible()
  const root = dialog.getByRole('combobox', {
    name: 'Authorized root to scan',
    includeHidden: true,
  })
  await expect(root).toBeVisible()
  expect(formRequests.get(page)).toHaveLength(1)
  await expect(page.getByTestId('operations')).toHaveText('["dev.project.bookmarks"]')
  await root.selectOption('root')
  const confirmation = dialog.getByRole('checkbox', { name: 'Fixture projectbun' })
  await confirmation.focus()
  await confirmation.press('Space')
  await expect(confirmation).toBeChecked()
  // Projects are bound by cloud project id; the form offers no group choice.
  await expect(page.getByRole('textbox', { name: 'New group name' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Import confirmed packages' }).click()
  await expect(page.getByTestId('announcement')).toHaveText('Imported 1 project.')
  await expect(page.getByTestId('imports')).toHaveText('1')
  await expect(page.getByTestId('imported-ids')).toHaveText(
    '["0d9e4f1a-1111-4000-8000-00000000c10d"]'
  )
  await expect(page.getByTestId('operations')).toHaveText(
    '["dev.project.bookmarks","dev.project.scan","dev.project.import"]'
  )
  // A successful import closes the dialog; reopening reuses the loaded form.
  await expect(dialog).toHaveCount(0)
  await openDialog(page)
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(formRequests.get(page)).toHaveLength(1)
})

test('authorizing a folder mints a root, lists it, and scans it', async ({ page }) => {
  await openDialog(page)
  const path = page.getByRole('textbox', { name: 'Folder path to authorize' })
  await expect(path).toBeVisible()
  await path.fill('/srv/checkout')
  await page.getByRole('button', { name: 'Authorize folder' }).click()
  await expect(page.getByTestId('announcement')).toHaveText(
    'Authorized Checkout. Scanning it for projects…'
  )
  // The authorize command ran, the bookmark list refreshed, and the new root
  // was selected and scanned without a second manual step.
  await expect(page.getByTestId('operations')).toHaveText(
    '["dev.project.bookmarks","dev.project.authorizeRoot","dev.project.bookmarks","dev.project.scan"]'
  )
  const root = page.getByRole('combobox', { name: 'Authorized root to scan', includeHidden: true })
  await expect(root).toBeVisible()
  await expect(root).toHaveValue('authorized')
  await expect(page.getByRole('checkbox', { name: 'Fixture projectbun' })).toBeVisible()
})

test('a refused authorization explains itself and keeps the draft path', async ({ page }) => {
  await openDialog(page)
  const path = page.getByRole('textbox', { name: 'Folder path to authorize' })
  await path.fill('/etc/disallowed')
  await page.getByRole('button', { name: 'Authorize folder' }).click()
  await expect(page.getByRole('alert')).toHaveText('/etc/disallowed is not authorized for import')
  await expect(path).toHaveValue('/etc/disallowed')
  await expect(page.getByTestId('operations')).toHaveText(
    '["dev.project.bookmarks","dev.project.authorizeRoot"]'
  )
})
