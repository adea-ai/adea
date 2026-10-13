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
// Success is the shared toast, so it is found the same way whether or not the panel is still mounted.
const archivedToast = (page: Page) =>
  page.getByText('Settings harness is archived', { exact: true })
const reopenRow = (page: Page, name: string) =>
  page.getByRole('button', { name: `Reopen ${name}`, exact: true })
const root = (page: Page) => page.locator('#harness-root')

test('the archive confirmation names its consequences and the live member count before committing', async ({
  page,
}) => {
  const errors = await openArchiveHarness(page, { 'data-archive-members': '3' })
  await archiveButton(page).click()
  const consequences = page.getByRole('list', { name: 'Archive consequences' })
  await expect(consequences).toContainText('2 other members lose access until you reopen it.')
  await expect(consequences).toContainText('Work that is already running is not cancelled.')
  await expect(consequences).toContainText(
    'Nothing is erased. Its history, links, jobs and artifacts are kept'
  )
  await expect(consequences).toContainText(
    'Permanent deletion stays unavailable until cleanup is verified.'
  )
  await expect(root(page)).not.toHaveAttribute('data-archive-calls')
  expect(errors).toEqual([])
})

test('an unreadable member list never invents a count', async ({ page }) => {
  const errors = await openArchiveHarness(page, { 'data-archive-members': 'error' })
  await archiveButton(page).click()
  await expect(page.getByRole('list', { name: 'Archive consequences' })).toContainText(
    'Every member loses access until you reopen it.'
  )
  expect(errors).toEqual([])
})

test('a failed or running member refresh never reuses an earlier count', async ({ page }) => {
  const errors = await openArchiveHarness(page, { 'data-archive-members': '3' })
  const consequences = page.getByRole('list', { name: 'Archive consequences' })
  await archiveButton(page).click()
  await expect(consequences).toContainText('2 other members lose access until you reopen it.')
  await page.getByRole('button', { name: 'Cancel' }).click()

  // Membership changes, then the next read fails: the cached "2 other members" is no longer evidence.
  await root(page).evaluate((element) => element.setAttribute('data-archive-members', 'error'))
  await archiveButton(page).click()
  await expect(consequences).toContainText('Every member loses access until you reopen it.')
  await expect(consequences).not.toContainText('other member')
  // The refresh runs its retries and settles as a failure; the generic warning holds throughout.
  await expect(root(page)).toHaveAttribute('data-members-calls', '5', { timeout: 20_000 })
  await expect(consequences).toContainText('Every member loses access until you reopen it.')
  await expect(consequences).not.toContainText('other member')

  // Once a read succeeds again, the new count is stated.
  await page.getByRole('button', { name: 'Cancel' }).click()
  await root(page).evaluate((element) => element.setAttribute('data-archive-members', '2'))
  await archiveButton(page).click()
  await expect(consequences).toContainText('1 other member loses access until you reopen it.')
  expect(errors).toEqual([])
})

test('the owner archives an optional workspace, finds it in the archived list, and reopens it', async ({
  page,
}) => {
  const errors = await openArchiveHarness(page)
  await archiveButton(page).click()
  await expect(page.getByText('Archive Settings harness?', { exact: true })).toBeVisible()
  await archiveButton(page).click()
  await expect(archivedToast(page)).toBeVisible()
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
  await expect(archivedToast(page)).toBeVisible()
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
  await expect(page.getByText('Archive Settings harness?', { exact: true })).toBeVisible()
  await archiveButton(page).click()
  await expect(archivedToast(page)).toBeVisible()
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
  await expect(archivedToast(page)).toBeVisible()
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
  await expect(archivedToast(page)).toBeVisible()
  await expect(root(page)).toHaveAttribute('data-archive-calls', '2')
  expect(errors).toEqual([])
})

const restoreButton = (page: Page, name: string) =>
  page.getByRole('button', { name: `Restore ${name}`, exact: true })

test('an archived project is restored only after an explicit confirmation at the listed revision', async ({
  page,
}) => {
  const errors = await openArchiveHarness(page, { 'data-archived-projects': '' })
  await expect(restoreButton(page, 'Billing rebuild')).toBeVisible()
  await expect(restoreButton(page, 'Mobile')).toBeVisible()
  await restoreButton(page, 'Billing rebuild').click()
  const consequences = page.getByRole('list', { name: 'Restore consequences' })
  await expect(consequences).toContainText(
    'It returns to the sidebar for everyone who can see it, with its conversations.'
  )
  await expect(consequences).toContainText('Who can see it does not change.')
  // Opening the confirmation sends nothing.
  await expect(root(page)).not.toHaveAttribute('data-restore-calls')
  await page.getByRole('button', { name: 'Restore project', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Archived projects status' })).toHaveText(
    'Billing rebuild is restored.'
  )
  await expect(root(page)).toHaveAttribute('data-restore-target', 'project-billing')
  await expect(root(page)).toHaveAttribute('data-restore-version', '3')
  await expect(root(page)).toHaveAttribute('data-restore-confirmed', 'true')
  await expect(restoreButton(page, 'Billing rebuild')).toHaveCount(0)
  await expect(restoreButton(page, 'Mobile')).toBeVisible()
  expect(errors).toEqual([])
})

test('cancelling the restore confirmation sends nothing', async ({ page }) => {
  const errors = await openArchiveHarness(page, { 'data-archived-projects': '' })
  await restoreButton(page, 'Mobile').click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Restore consequences' })).toHaveCount(0)
  await expect(restoreButton(page, 'Mobile')).toBeVisible()
  await expect(root(page)).not.toHaveAttribute('data-restore-calls')
  expect(errors).toEqual([])
})

test('a project that changed since it was listed is refused, not forced, and the list is read again', async ({
  page,
}) => {
  const errors = await openArchiveHarness(page, {
    'data-archived-projects': '',
    'data-restore-mode': 'conflict',
  })
  await restoreButton(page, 'Billing rebuild').click()
  await page.getByRole('button', { name: 'Restore project', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('This project changed since it was listed.')
  await expect(root(page)).toHaveAttribute('data-restore-calls', '1')
  // The conflict closes the confirmation: the owner reviews the refreshed row and decides again.
  await expect(page.getByRole('list', { name: 'Restore consequences' })).toHaveCount(0)
  await expect(restoreButton(page, 'Billing rebuild')).toBeVisible()
  expect(errors).toEqual([])
})

test('a transient restore failure keeps the confirmation open for a retry', async ({ page }) => {
  const errors = await openArchiveHarness(page, {
    'data-archived-projects': '',
    'data-restore-mode': 'error',
  })
  await restoreButton(page, 'Mobile').click()
  await page.getByRole('button', { name: 'Restore project', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(
    'The project could not be restored. Try again.'
  )
  await expect(page.getByRole('list', { name: 'Restore consequences' })).toBeVisible()
  await root(page).evaluate((element) => element.setAttribute('data-restore-mode', 'ok'))
  await page.getByRole('button', { name: 'Restore project', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Archived projects status' })).toHaveText(
    'Mobile is restored.'
  )
  expect(errors).toEqual([])
})

test('a workspace with no archived projects says so', async ({ page }) => {
  const errors = await openArchiveHarness(page)
  await expect(page.getByText('No archived projects.')).toBeVisible()
  expect(errors).toEqual([])
})
