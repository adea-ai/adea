import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * Archive and reopen from the General settings section (M11.04, #1175). The harness answers the archive
 * and reopen contract from data attributes, so each case stages one server outcome. The Home case
 * proves the row never mounts for the personal workspace.
 */
async function openArchiveHarness(
  page: Page,
  attributes: Record<string, string> = {}
): Promise<Error[]> {
  const path = '/__workspace-settings'
  const errors: Error[] = []
  page.on('pageerror', (error) => errors.push(error))
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(`${path}#workspace-settings/general`)
  await page.locator('#harness-root').evaluate(
    (element, entries) => {
      for (const [name, value] of entries) element.setAttribute(name, value)
    },
    [['data-archive-client', ''], ...Object.entries(attributes)] as const
  )
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-settings-harness-app.tsx')
  )
  return errors
}

const archiveButton = (page: Page) =>
  page.getByRole('button', { name: 'Archive workspace', exact: true })

test('the owner archives an optional workspace, keeps its history, and reopens it from the same panel', async ({
  page,
}) => {
  const errors = await openArchiveHarness(page)
  await expect(archiveButton(page)).toBeVisible()
  await archiveButton(page).click()
  await expect(
    page.getByText('Archive Settings harness? It is hidden from your workspace list.')
  ).toBeVisible()
  await archiveButton(page).click()
  await expect(page.getByRole('status', { name: 'Archive status' })).toHaveText(
    'Settings harness is archived. Its history and links are kept.'
  )
  await page.getByRole('button', { name: 'Reopen workspace', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Archive status' })).toHaveText(
    'Settings harness is reopened.'
  )
  await expect(archiveButton(page)).toBeVisible()
  await expect(page.locator('#harness-root')).toHaveAttribute('data-archive-calls', '1')
  await expect(page.locator('#harness-root')).toHaveAttribute('data-reopen-calls', '1')
  expect(errors).toEqual([])
})

test('Home never mounts the archive row', async ({ page }) => {
  const errors = await openArchiveHarness(page, { 'data-personal': '' })
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(archiveButton(page)).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a refused archive keeps the workspace, explains the refusal, and retries', async ({
  page,
}) => {
  const errors = await openArchiveHarness(page, { 'data-archive-mode': 'unavailable' })
  await archiveButton(page).click()
  await archiveButton(page).click()
  await expect(page.getByRole('alert')).toContainText('This workspace is unavailable.')
  await expect(page.getByRole('button', { name: 'Archive workspace', exact: true })).toBeVisible()
  await expect(page.locator('#harness-root')).toHaveAttribute('data-archive-calls', '1')
  await page
    .locator('#harness-root')
    .evaluate((element) => element.setAttribute('data-archive-mode', 'ok'))
  await archiveButton(page).click()
  await expect(page.getByRole('status', { name: 'Archive status' })).toHaveText(
    'Settings harness is archived. Its history and links are kept.'
  )
  expect(errors).toEqual([])
})

test('a transient failure shows a retry message, and a double click archives once', async ({
  page,
}) => {
  const errors = await openArchiveHarness(page, { 'data-archive-mode': 'error' })
  await archiveButton(page).click()
  await archiveButton(page).dblclick()
  await expect(page.getByRole('alert')).toContainText('Workspace could not be archived. Try again.')
  // The second click landed on the pending button: one request reached the server, not two.
  await expect(page.locator('#harness-root')).toHaveAttribute('data-archive-calls', '1')
  await page
    .locator('#harness-root')
    .evaluate((element) => element.setAttribute('data-archive-mode', 'ok'))
  await archiveButton(page).click()
  await expect(page.locator('#harness-root')).toHaveAttribute('data-archive-calls', '2')
  await expect(page.getByRole('status', { name: 'Archive status' })).toHaveText(
    'Settings harness is archived. Its history and links are kept.'
  )
  expect(errors).toEqual([])
})
