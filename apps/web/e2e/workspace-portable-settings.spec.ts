import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * Export and restore from the General settings section (#1245 contract). The harness answers the
 * portable export and import calls from data attributes, so each case stages one server outcome.
 * The server routes and their refusals are covered by the web integration tests.
 */
async function openHarness(page: Page, attributes: Record<string, string> = {}): Promise<Error[]> {
  const path = '/__workspace-settings'
  const errors: Error[] = []
  page.on('pageerror', (error) => errors.push(error))
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(`${path}#settings/workspace-general`)
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

const root = (page: Page) => page.locator('#harness-root')
const exportButton = (page: Page) => page.getByRole('button', { name: 'Export…', exact: true })
const downloadButton = (page: Page) =>
  page.getByRole('button', { name: 'Download export', exact: true })
const chooseButton = (page: Page) =>
  page.getByRole('button', { name: 'Choose export file…', exact: true })
const restoreButton = (page: Page) =>
  page.getByRole('button', { name: 'Restore workspace', exact: true })
const fileInput = (page: Page) => page.getByLabel('Export file to restore')

const exportFile = (name = 'Design explorations') =>
  JSON.stringify({
    content: {
      agents: [{}, {}, {}, {}],
      channels: [{}, {}],
      messages: [{}, {}, {}],
      projects: [{}],
      tasks: [{}],
      users: [{ displayName: 'Sam Rivera', userId: 'user-1' }],
      workspace: { name },
    },
    exportedAt: '2026-10-12T09:30:00.000Z',
    exportedBy: { role: 'owner', userId: 'user-1' },
    format: 'adea.portable-workspace-export',
    formatVersion: 1,
  })

const chooseFile = (page: Page, contents: string, name = 'workspace-8f3c.portable.json') =>
  fileInput(page).setInputFiles({
    buffer: Buffer.from(contents),
    mimeType: 'application/json',
    name,
  })

test('export says what the file holds and downloads it for the open workspace', async ({
  page,
}) => {
  const errors = await openHarness(page)
  await exportButton(page).click()
  await expect(page.getByText('Conversations and messages you can read')).toBeVisible()
  await expect(page.getByText('Workspace members and roles')).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    downloadButton(page).click(),
  ])
  expect(download.suggestedFilename()).toBe('workspace-workspace-settings-e2e.portable.json')
  await expect(page.getByRole('status').filter({ hasText: 'Downloaded workspace-' })).toBeVisible()
  await expect(root(page)).toHaveAttribute('data-export-calls', '1')
  await expect(root(page)).toHaveAttribute('data-export-target', 'workspace-settings-e2e')
  await expect(page.getByRole('button', { name: 'Export again', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('cancelling the export review downloads nothing', async ({ page }) => {
  await openHarness(page)
  await exportButton(page).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(exportButton(page)).toBeVisible()
  await expect(root(page)).not.toHaveAttribute('data-export-calls', /.*/)
})

test('an export over the limit explains itself and can be tried again', async ({ page }) => {
  await openHarness(page, { 'data-export-mode': 'too_large' })
  await exportButton(page).click()
  await downloadButton(page).click()
  await expect(
    page.getByText('over the export limit of 10,000 records or 8 MB', { exact: false })
  ).toBeVisible()
  await expect(exportButton(page)).toBeEnabled()
})

test('an unavailable workspace cannot be exported again', async ({ page }) => {
  await openHarness(page, { 'data-export-mode': 'unavailable' })
  await exportButton(page).click()
  await downloadButton(page).click()
  await expect(page.getByText('This workspace is unavailable.', { exact: false })).toBeVisible()
  await expect(exportButton(page)).toBeDisabled()
})

test('restore shows what the file holds, then restores it and offers the new workspace', async ({
  page,
}) => {
  const contents = exportFile()
  const errors = await openHarness(page)
  await chooseFile(page, contents)
  await expect(page.getByText('workspace-8f3c.portable.json')).toBeVisible()
  await expect(
    page.getByText('exported Oct 12, 2026 by Sam Rivera', { exact: false })
  ).toBeVisible()
  await expect(page.getByText('Design explorations', { exact: true })).toBeVisible()
  await expect(page.getByText('1 project', { exact: true })).toBeVisible()
  await expect(page.getByText('3 messages', { exact: true })).toBeVisible()
  // The history promise is only for people who were in the conversation when it was exported.
  await expect(
    page.getByText('If you weren’t one of them, you won’t see that history automatically.', {
      exact: false,
    })
  ).toBeVisible()
  await expect(page.getByText('you both read', { exact: false })).toHaveCount(0)
  await restoreButton(page).click()
  await expect(page.getByText('is restored and you own it.', { exact: false })).toBeVisible()
  await expect(page.getByText('842 messages', { exact: true })).toBeVisible()
  await expect(root(page)).toHaveAttribute('data-import-calls', '1')
  await expect(root(page)).toHaveAttribute('data-import-length', String(contents.length))
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await expect(root(page)).toHaveAttribute('data-opened-workspace', 'restored-workspace')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(chooseButton(page)).toBeVisible()
  expect(errors).toEqual([])
})

test('a file that is not an Adea export is refused without calling the server', async ({
  page,
}) => {
  await openHarness(page)
  await chooseFile(page, 'not json', 'notes.json')
  await expect(
    page.getByText('isn’t a valid Adea workspace export', { exact: false })
  ).toBeVisible()
  await expect(chooseButton(page)).toBeVisible()
  await expect(root(page)).not.toHaveAttribute('data-import-calls', /.*/)
})

test('a server refusal keeps the file chosen, names the reason, and retries', async ({ page }) => {
  await openHarness(page, { 'data-import-refusal': 'target_exists' })
  await chooseFile(page, exportFile())
  await restoreButton(page).click()
  await expect(page.getByText('already exists here', { exact: false })).toBeVisible()
  await expect(page.getByText('workspace-8f3c.portable.json')).toBeVisible()
  await restoreButton(page).click()
  await expect(page.getByText('is restored and you own it.', { exact: false })).toBeVisible()
  await expect(root(page)).toHaveAttribute('data-import-calls', '2')
})

test('cancelling a chosen file returns to the picker', async ({ page }) => {
  await openHarness(page)
  await chooseFile(page, exportFile())
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(chooseButton(page)).toBeVisible()
  await expect(root(page)).not.toHaveAttribute('data-import-calls', /.*/)
})

/**
 * Holds the read of files whose name starts with `slow-` until `release()` runs, and fails the
 * read of `broken.json`, so a late or failed read is reachable from a test.
 */
async function stageReads(page: Page) {
  await page.evaluate(() => {
    const original = File.prototype.text
    const latch = Promise.withResolvers<void>()
    Object.assign(window, { releaseSlowReads: () => latch.resolve() })
    File.prototype.text = async function text(this: File) {
      if (this.name.startsWith('slow-')) await latch.promise
      if (this.name === 'broken.json') throw new DOMException('unreadable', 'NotReadableError')
      return original.call(this)
    }
  })
}
const releaseSlowReads = (page: Page) =>
  page.evaluate(() => (window as unknown as { releaseSlowReads(): void }).releaseSlowReads())

test('choosing another file while one is still being read restores the later file only', async ({
  page,
}) => {
  const first = exportFile('First workspace')
  const second = exportFile('Second workspace')
  await openHarness(page)
  await stageReads(page)
  await chooseFile(page, first, 'slow-first.json')
  await expect(page.getByText('Reading file…')).toBeVisible()
  await expect(restoreButton(page)).toHaveCount(0)
  await chooseFile(page, second, 'second.json')
  await expect(page.getByText('Second workspace', { exact: true })).toBeVisible()
  // The first read finishing now must not replace the file that was chosen after it.
  await releaseSlowReads(page)
  await page.waitForTimeout(100)
  await expect(page.getByText('Second workspace', { exact: true })).toBeVisible()
  await expect(page.getByText('slow-first.json')).toHaveCount(0)
  await restoreButton(page).click()
  await expect(page.getByText('is restored and you own it.', { exact: false })).toBeVisible()
  await expect(root(page)).toHaveAttribute('data-import-length', String(second.length))
})

test('cancelling while a file is being read stays cancelled when the read finishes', async ({
  page,
}) => {
  await openHarness(page)
  await stageReads(page)
  await chooseFile(page, exportFile(), 'slow-file.json')
  await expect(page.getByText('Reading file…')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(chooseButton(page)).toBeVisible()
  await releaseSlowReads(page)
  await page.waitForTimeout(100)
  await expect(chooseButton(page)).toBeVisible()
  await expect(restoreButton(page)).toHaveCount(0)
  await expect(root(page)).not.toHaveAttribute('data-import-calls', /.*/)
})

test('a file the browser cannot read is reported and can be replaced', async ({ page }) => {
  await openHarness(page)
  await stageReads(page)
  await chooseFile(page, exportFile(), 'broken.json')
  await expect(page.getByText('This file couldn’t be read.', { exact: false })).toBeVisible()
  await expect(chooseButton(page)).toBeVisible()
  await chooseFile(page, exportFile('Recovered'), 'fine.json')
  await expect(page.getByText('Recovered', { exact: true })).toBeVisible()
})

test('Open workspace says so when the restored workspace cannot be opened yet, and retries', async ({
  page,
}) => {
  await openHarness(page, { 'data-open-failure': '' })
  await chooseFile(page, exportFile())
  await restoreButton(page).click()
  const open = page.getByRole('button', { name: 'Open workspace', exact: true })
  await open.click()
  await expect(page.getByText('couldn’t be opened yet', { exact: false })).toBeVisible()
  await expect(root(page)).not.toHaveAttribute('data-opened-workspace', /.*/)
  await expect(open).toBeEnabled()
  await open.click()
  await expect(root(page)).toHaveAttribute('data-opened-workspace', 'restored-workspace')
  await expect(page.getByText('couldn’t be opened yet', { exact: false })).toHaveCount(0)
})
