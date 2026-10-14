import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * The theme importer loads when a file is chosen, never when Appearance opens, and an import that
 * the dialog or a newer file has superseded stores nothing. The harness mounts the real
 * AppearanceControl over the shared ThemeProvider, as workspace-accent-selector does.
 */
const IMPORTER = /custom-theme-import/

const paperRose = {
  name: 'Paper Rose',
  appearance: 'light',
  colors: {
    background: '#faf7f5',
    foreground: '#40342f',
    surface: '#f3edeb',
    surfaceElevated: '#ffffff',
    surfaceHover: '#efe6e3',
    surfaceActive: '#e6d9d5',
    border: '#d8c8c3',
    borderMuted: '#e4d8d4',
    text: '#40342f',
    textMuted: '#7a6a63',
    textSubtle: '#6f625b',
    accent: '#b4536a',
    accentForeground: '#ffffff',
    success: '#2f7d4f',
    warning: '#9a6200',
    error: '#b3261e',
    info: '#2a5db0',
  },
}

async function openLibrary(page: Page, importerRequests: string[]) {
  page.on('request', (request) => {
    if (IMPORTER.test(request.url())) importerRequests.push(request.url())
  })
  const path = '/__workspace-theme-import'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-appearance-harness-app.tsx')
  )
  await page.getByRole('button', { name: 'Appearance settings', exact: true }).click()
  const popup = page.getByRole('dialog', { name: 'Appearance', exact: true })
  await popup.getByRole('button', { name: 'Manage themes', exact: true }).click()
  const library = page.getByRole('dialog', { name: 'Manage themes', exact: true })
  await expect(library).toBeVisible()
  return { popup, library }
}

const chooseFile = (library: ReturnType<Page['getByRole']>, name: string, body: string) =>
  library.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(body),
  })

const storedLibrary = (page: Page) =>
  page.evaluate(() => localStorage.getItem('appearance.library'))

test('opening Appearance and the library never loads the importer; choosing a file does', async ({
  page,
}) => {
  const importerRequests: string[] = []
  const { library } = await openLibrary(page, importerRequests)
  expect(importerRequests).toEqual([])

  await chooseFile(library, 'paper-rose.json', JSON.stringify(paperRose))
  await expect(library.getByRole('status')).toContainText('Imported “Paper Rose”.')
  expect(importerRequests.length).toBeGreaterThan(0)
  await expect(library.getByText('Paper Rose', { exact: true })).toBeVisible()
  expect(JSON.parse((await storedLibrary(page))!).themes).toHaveLength(1)
})

test('a file that is not a theme reports the error and stores nothing', async ({ page }) => {
  const { library } = await openLibrary(page, [])
  await chooseFile(library, 'broken.json', '{ not json')
  await expect(library.getByRole('status')).toHaveText('That file is not valid JSON.')
  expect(await storedLibrary(page)).toBeNull()
})

test('an importer chunk that fails to load reports an error and stores nothing', async ({
  page,
}) => {
  const { library } = await openLibrary(page, [])
  await page.route(IMPORTER, (route) => route.abort())
  await chooseFile(library, 'paper-rose.json', JSON.stringify(paperRose))
  await expect(library.getByRole('status')).toContainText('could not be loaded')
  await expect(library.getByRole('status')).toHaveAttribute('aria-busy', 'false')
  expect(await storedLibrary(page)).toBeNull()
})

test('closing the dialog while the importer loads drops the import', async ({ page }) => {
  const { popup, library } = await openLibrary(page, [])
  const gate = Promise.withResolvers<void>()
  await page.route(IMPORTER, async (route) => {
    await gate.promise
    await route.continue()
  })
  await chooseFile(library, 'paper-rose.json', JSON.stringify(paperRose))
  await expect(library.getByRole('status')).toHaveText('Importing theme…')
  await library.locator('footer').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(library).toBeHidden()
  gate.resolve()
  await page.waitForTimeout(500)
  expect(await storedLibrary(page)).toBeNull()
  await popup.getByRole('button', { name: 'Manage themes', exact: true }).click()
  const reopened = page.getByRole('dialog', { name: 'Manage themes', exact: true })
  await expect(reopened.getByRole('status')).toHaveCount(0)
  await expect(reopened.getByText('Paper Rose', { exact: true })).toHaveCount(0)
})
