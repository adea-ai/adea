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

const createProject = async (page: Page) => {
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New project in Fixture workspace' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Cloud project')
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByTestId('created-names')).toHaveText('["Cloud project"]')
  return dialog
}

test('the shared detailed flow can create a project without binding a repository', async ({
  page,
}) => {
  const dialog = await createProject(page)
  await expect(dialog.getByRole('tab', { name: 'On this Mac' })).toBeVisible()
  await expect(dialog.getByRole('tab', { name: 'From GitHub' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Skip for now' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('imports')).toHaveText('0')
  await expect(page.getByTestId('refreshes')).toHaveText('2')
  await expect(page.getByTestId('operations')).toHaveText('["dev.project.bookmarks"]')
})

test('the native picker fills the local path while authorization and confirmation still gate import', async ({
  page,
}) => {
  const dialog = await createProject(page)
  const path = dialog.getByRole('textbox', { name: 'Folder path to authorize' })
  await dialog.getByRole('button', { name: 'Choose folder…' }).click()
  await expect(path).toHaveValue('/srv/checkout')
  await expect(page.getByTestId('picker-calls')).toHaveText('1')
  await expect(page.getByTestId('operations')).toHaveText('["dev.project.bookmarks"]')
  await dialog.getByRole('button', { name: 'Authorize folder' }).click()
  const confirmation = dialog.getByRole('checkbox', { name: 'Fixture projectbun' })
  await expect(confirmation).toBeVisible()
  await expect(page.getByTestId('imports')).toHaveText('0')
  await confirmation.focus()
  await confirmation.press('Space')
  await expect(confirmation).toBeChecked()
  await dialog.getByRole('button', { name: 'Import confirmed packages' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('imported-ids')).toHaveText(
    '["0d9e4f1a-1111-4000-8000-00000000c10d"]'
  )
})

test('the unified project dialog retains GitHub import and the cloud project identity', async ({
  page,
}) => {
  const dialog = await createProject(page)
  await dialog.getByRole('tab', { name: 'From GitHub' }).click()
  await expect(dialog.getByRole('button', { name: 'Choose folder…' })).toHaveCount(0)
  await dialog.getByRole('searchbox', { name: 'Filter GitHub repositories' }).fill('repository')
  await dialog.getByRole('button', { name: /^fixture\/repository/ }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('clone-bodies')).toHaveText(
    JSON.stringify([
      {
        projectId: '0d9e4f1a-1111-4000-8000-00000000c10d',
        mode: 'managed',
        remote: {
          provider: 'github',
          host: 'github.com',
          ownerPath: 'fixture',
          repository: 'repository',
        },
      },
    ])
  )
  await expect(page.getByTestId('announcement')).toHaveText(
    'Cloned fixture/repository into this project.'
  )
})

test('cancelling the native picker keeps the typed path and issues no authorization', async ({
  page,
}) => {
  await page.evaluate(() => {
    ;(window as unknown as { cancelPicker: boolean }).cancelPicker = true
  })
  const dialog = await createProject(page)
  const path = dialog.getByRole('textbox', { name: 'Folder path to authorize' })
  await path.fill('/srv/typed')
  await dialog.getByRole('button', { name: 'Choose folder…' }).click()
  await expect(page.getByTestId('picker-calls')).toHaveText('1')
  await expect(path).toHaveValue('/srv/typed')
  await expect(page.getByTestId('operations')).toHaveText('["dev.project.bookmarks"]')
})

test('the shared adapter keeps the basic cloud dialog when no runtime flow is injected', async ({
  page,
}) => {
  await page.evaluate(() => {
    ;(window as unknown as { basic: boolean }).basic = true
  })
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create Project', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Choose folder…' })).toHaveCount(0)
  await expect(dialog.getByRole('tab', { name: 'From GitHub' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Engineering', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('created-names')).toHaveText('["Engineering"]')
  await expect(page.getByTestId('operations')).toHaveText('[]')
  await expect(page.getByTestId('refreshes')).toHaveText('0')
})

test('a project-list refresh preserves an open detailed dialog and its typed draft', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New project in Fixture workspace' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Draft project')
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()
  const path = dialog.getByRole('textbox', { name: 'Folder path to authorize' })
  await path.fill('/srv/typed-draft')
  await page.evaluate(() => window.dispatchEvent(new Event('project-list-refresh')))
  await expect(page.getByTestId('known-names')).toHaveText('["Another project"]')
  await expect(path).toHaveValue('/srv/typed-draft')
  await expect(dialog.getByRole('button', { name: 'Choose folder…' })).toBeVisible()
  await expect(page.getByTestId('created-names')).toHaveText('["Draft project"]')
  await expect(page.getByTestId('operations')).toHaveText('["dev.project.bookmarks"]')
})
