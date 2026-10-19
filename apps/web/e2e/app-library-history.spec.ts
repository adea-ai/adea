// App Library on the real route: the router's history owns the library and each app switch. These
// journeys use the actual shell (no harness) with every workspace API mocked, so no database is needed.
// The bootstrap helper mirrors workspace-selection-deep-links.spec.ts; it is copied here, not shared,
// so this spec adds no edit to an existing file.
import { expect, test, type Page } from '@playwright/test'

const timestamp = '2026-10-19T10:00:00.000Z'
const workWorkspace = {
  id: 'workspace-library-history-work',
  name: 'Work',
  scene: 'work',
  accent: null,
  logo: { kind: 'monogram' as const },
  sortOrder: 0,
  version: 1,
  updatedAt: timestamp,
}

async function mockWorkspaceBootstrap(page: Page) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('adea:e2e-initialized')) {
      localStorage.clear()
      localStorage.setItem('theme', 'light')
      // Explicit existing-user choices: Chat and Dev on the rail; Kanban is hidden so it can be enabled in place.
      localStorage.setItem(
        'adea:rail-preferences:v1',
        JSON.stringify({ version: 1, order: ['chat', 'dev', 'kanban'], hidden: ['kanban'] })
      )
      sessionStorage.setItem('adea:e2e-initialized', 'true')
    }
  })
  await page.route('**/api/workspaces/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        activeWorkspace: workWorkspace,
        principal: { temporary: true, userId: 'library-history-e2e-user' },
        workspaces: [workWorkspace],
      },
    })
  )
  await page.route('**/api/v1/workspaces/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.includes('/read-state'))
      return route.fulfill({ contentType: 'application/json', json: { readState: [] } })
    if (url.pathname.endsWith('/messages'))
      return route.fulfill({
        contentType: 'application/json',
        json: { messages: [], nextAfterSequence: null },
      })
    if (route.request().method() !== 'GET')
      return route.fulfill({ contentType: 'application/json', json: {} })
    if (url.pathname.endsWith('/search'))
      return route.fulfill({
        contentType: 'application/json',
        json: { privateResultsUnavailable: true, results: [] },
      })
    return route.fulfill({ contentType: 'application/json', json: [] })
  })
}

async function openShell(page: Page, url: string) {
  await mockWorkspaceBootstrap(page)
  await page.goto(url, { timeout: 60_000 })
  const globalNavigation = page.getByRole('navigation', { name: 'Global navigation' })
  // Cold dev-server transforms of the lazy shell can be slow; give the mount the same headroom.
  await expect(globalNavigation).toBeVisible({ timeout: 60_000 })
  return globalNavigation
}

const openLibrary = async (page: Page) => {
  await page.getByRole('button', { name: 'App Library', exact: true }).click()
  await expect(page).toHaveURL(/app=library/)
  await expect(page.getByRole('button', { name: 'Open Dev', exact: true })).toBeVisible()
}

test('an app opened from the library is a history step: Back returns to the library and Forward returns to the app', async ({
  page,
}) => {
  await openShell(page, '/?view=dev')
  await openLibrary(page)
  await page.getByRole('button', { name: 'Open Chat', exact: true }).click()
  await expect(page).not.toHaveURL(/app=library/)
  await expect(page.getByRole('button', { name: 'Open Dev', exact: true })).toHaveCount(0)

  await page.goBack()
  await expect(page).toHaveURL(/app=library/)
  await expect(page.getByRole('button', { name: 'Open Dev', exact: true })).toBeVisible()

  await page.goForward()
  await expect(page).not.toHaveURL(/app=library/)
  await expect(page.getByRole('button', { name: 'Open Dev', exact: true })).toHaveCount(0)
})

test('one Back from the library leaves it, even after the library enabled an app in place', async ({
  page,
}) => {
  await openShell(page, '/')
  await openLibrary(page)
  await page.getByRole('button', { name: 'Enable Kanban', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Disable Kanban', exact: true })).toBeVisible()
  // Enabling in place is a customization, not a navigation: the URL still names the library once.
  await expect(page).toHaveURL(/app=library/)

  await page.goBack()
  await expect(page).not.toHaveURL(/app=library/)
  await expect(page.getByRole('button', { name: 'Open Dev', exact: true })).toHaveCount(0)
})

test('disabling the open destination from the library keeps the library open and adds no history step', async ({
  page,
}) => {
  await openShell(page, '/')
  await openLibrary(page)
  // Chat is the requested destination; hiding it is a recorded change that must not dismiss the library.
  await page.getByRole('button', { name: 'Disable Chat', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Enable Chat', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/app=library/)

  await page.goBack()
  await expect(page).not.toHaveURL(/app=library/)
})
