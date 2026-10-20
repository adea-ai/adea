import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

// Browser-mounted checks of the App Library page and its navigation rules. The real page and the real
// rules mount in the page; the shell that owns them is a signal-driven fixture, so no router or native
// surface runs here.
test.use({ headless: true })

test.beforeEach(async ({ page }) => {
  await page.route('**/__app-library-navigation', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto('/__app-library-navigation')
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/app-library-navigation-harness-app.tsx')
  )
  await expect(page.getByTestId('library-open')).toHaveText('yes')
})

const searchBox = (page: Page) => page.getByRole('searchbox', { name: 'Search apps' })

test('enabling an app from the library keeps the library open and the destination unchanged', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Enable Kanban', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Disable Kanban', exact: true })).toBeVisible()
  await expect(page.getByTestId('library-open')).toHaveText('yes')
  await expect(page.getByTestId('destination')).toHaveText('chat')
  await expect(page.getByTestId('history')).toHaveText('')
})

test('opening an enabled app from the library moves to it and closes the library', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Open Dev', exact: true }).click()
  await expect(page.getByTestId('destination')).toHaveText('dev')
  await expect(page.getByTestId('library-open')).toHaveText('no')
  await expect(page.getByTestId('history')).toHaveText('dev')
})

test('a request for an app outside the rail opens the library instead of redirecting', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Open Chat', exact: true }).click()
  await expect(page.getByTestId('library-open')).toHaveText('no')
  await expect(page.getByTestId('history')).toHaveText('chat')
  await page.getByRole('button', { name: 'Request Source control', exact: true }).click()
  await expect(page.getByTestId('library-open')).toHaveText('yes')
  await expect(page.getByTestId('destination')).toHaveText('chat')
  await expect(page.getByTestId('history')).toHaveText('chat')
})

test('the search text stays while enabling an app from the filtered library', async ({ page }) => {
  await searchBox(page).fill('kan')
  await page.getByRole('button', { name: 'Enable Kanban', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Disable Kanban', exact: true })).toBeVisible()
  await expect(searchBox(page)).toHaveValue('kan')
  await expect(page.getByTestId('library-open')).toHaveText('yes')
})

test('Reset Navigation keeps the library open and restores the default rail', async ({ page }) => {
  await page.getByRole('button', { name: 'Enable Kanban', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Disable Kanban', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Reset Navigation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Enable Kanban', exact: true })).toBeVisible()
  await expect(page.getByTestId('library-open')).toHaveText('yes')
  await expect(page.getByTestId('destination')).toHaveText('chat')
})
