import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * Archive, durable discovery and reopen from the General settings section (M11.04, #1175). The
 * harness answers the archive, archived-listing and reopen contract from module state and data
 * attributes, so each case stages one server outcome. The real shell is covered by
 * workspace-archive-lifecycle.spec.ts against the running app.
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
const archiveStatus = (page: Page) => page.getByRole('status', { name: 'Archive status' })
const reopenRow = (page: Page, name: string) =>
  page.getByRole('button', { name: `Reopen ${name}`, exact: true })
const root = (page: Page) => page.locator('#harness-root')

test('the owner archives an optional workspace, finds it in the archived list, and reopens it', async ({
  page,
}) => {
  const errors = await openArchiveHarness(page)
  await archiveButton(page).click()
  await expect(
    page.getByText('Archive Settings harness? It is hidden from your workspace list.')
  ).toBeVisible()
  await archiveButton(page).click()
  await expect(archiveStatus(page)).toHaveText(
    'Settings harness is archived. Its history and links are kept.'
  )
  await expect(reopenRow(page, 'Settings harness')).toBeVisible()
  await reopenRow(page, 'Settings harness').click()
  await expect(page.getByRole('status', { name: 'Archived workspaces status' })).toHaveText(
    'Settings harness is reopened.'
  )
  await expect(reopenRow(page, 'Settings harness')).toHaveCount(0)
  await expect(root(page)).toHaveAttribute('data-archive-calls', '1')
  await expect(root(page)).toHaveAttribute('data-reopen-calls', '1')
  expect(errors).toEqual([])
})

test('an archived workspace stays listed after the panel closes and reopens from its own row', async ({
  page,
}) => {
  const errors = await openArchiveHarness(page)
  await archiveButton(page).click()
  await archiveButton(page).click()
  await expect(archiveStatus(page)).toHaveText(
    'Settings harness is archived. Its history and links are kept.'
  )
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Open settings fixture' }).click()
  await expect(reopenRow(page, 'Settings harness')).toBeVisible()
  await reopenRow(page, 'Settings harness').click()
  await expect(page.getByRole('status', { name: 'Archived workspaces status' })).toHaveText(
    'Settings harness is reopened.'
  )
  expect(errors).toEqual([])
})

test('the confirmation keeps its captured target when the active workspace changes while it is open', async ({
  page,
}) => {
  const errors = await openArchiveHarness(page)
  await archiveButton(page).click()
  // The modal covers the switch control, so the change is driven on the control itself: the active
  // workspace changes while the confirmation is open, which is the case under test.
  await page
    .locator('#switch-fixture-workspace')
    .evaluate((element) => (element as HTMLElement).click())
  await expect(
    page.getByText('Archive Settings harness? It is hidden from your workspace list.')
  ).toBeVisible()
  await archiveButton(page).click()
  await expect(archiveStatus(page)).toHaveText(
    'Settings harness is archived. Its history and links are kept.'
  )
  await expect(root(page)).toHaveAttribute('data-archive-target', 'workspace-settings-e2e')
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
  await expect(archiveButton(page)).toBeVisible()
  await expect(root(page)).toHaveAttribute('data-archive-calls', '1')
  await root(page).evaluate((element) => element.setAttribute('data-archive-mode', 'ok'))
  await archiveButton(page).click()
  await expect(archiveStatus(page)).toHaveText(
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
  await expect(root(page)).toHaveAttribute('data-archive-calls', '1')
  await root(page).evaluate((element) => element.setAttribute('data-archive-mode', 'ok'))
  await archiveButton(page).click()
  await expect(archiveStatus(page)).toHaveText(
    'Settings harness is archived. Its history and links are kept.'
  )
  await expect(root(page)).toHaveAttribute('data-archive-calls', '2')
  expect(errors).toEqual([])
})
