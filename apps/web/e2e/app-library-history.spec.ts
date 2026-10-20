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

// The rail's view buttons are pressed when their view is the active surface; App Library is pressed
// while the library is open. These are the surface facts the assertions check, not just the URL.
const railButton = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Global navigation' })
    .getByRole('button', { name, exact: true })
const chatRail = (page: Page) => railButton(page, 'Chat view')
const devRail = (page: Page) => railButton(page, 'Dev view')
const libraryRail = (page: Page) => railButton(page, 'App Library')

const openLibrary = async (page: Page) => {
  await libraryRail(page).click()
  await expect(page).toHaveURL(/app=library/)
  await expect(libraryRail(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Open Dev', exact: true })).toBeVisible()
}

test('an app opened from the library is a history step: Back returns to the library and Forward returns to Chat', async ({
  page,
}) => {
  // Starting surface: Dev, so the Chat step below is a real change of surface.
  await openShell(page, '/?view=dev')
  await expect(devRail(page)).toHaveAttribute('aria-pressed', 'true')

  await openLibrary(page)
  await expect(devRail(page)).not.toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'Open Chat', exact: true }).click()
  await expect(page).not.toHaveURL(/app=library/)
  await expect(page).not.toHaveURL(/view=dev/)
  await expect(chatRail(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(libraryRail(page)).not.toHaveAttribute('aria-pressed', 'true')

  await page.goBack()
  await expect(page).toHaveURL(/app=library/)
  await expect(libraryRail(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Open Dev', exact: true })).toBeVisible()

  await page.goForward()
  await expect(page).not.toHaveURL(/app=library/)
  await expect(page).not.toHaveURL(/view=dev/)
  await expect(chatRail(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Open Dev', exact: true })).toHaveCount(0)
})

test('one Back from the library returns to Chat, even after the library enabled an app in place', async ({
  page,
}) => {
  await openShell(page, '/')
  await expect(chatRail(page)).toHaveAttribute('aria-pressed', 'true')

  await openLibrary(page)
  await page.getByRole('button', { name: 'Enable Kanban', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Disable Kanban', exact: true })).toBeVisible()
  // Enabling in place is a customization, not a navigation: the URL still names the library once.
  await expect(page).toHaveURL(/app=library/)

  await page.goBack()
  await expect(page).not.toHaveURL(/app=library/)
  await expect(chatRail(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Open Dev', exact: true })).toHaveCount(0)
})

test('disabling the open destination from the library adds no history step, and Back to the hidden Chat falls back to Dev', async ({
  page,
}) => {
  await openShell(page, '/')
  await expect(chatRail(page)).toHaveAttribute('aria-pressed', 'true')

  await openLibrary(page)
  // Chat is the requested destination; hiding it is a recorded change that must not dismiss the library.
  await page.getByRole('button', { name: 'Disable Chat', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Enable Chat', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/app=library/)
  await expect(libraryRail(page)).toHaveAttribute('aria-pressed', 'true')

  // Back goes to the entry before the library, which asks for Chat. Chat is hidden, so the
  // recovery rule rewrites the surface to Dev and leaves the library closed.
  await page.goBack()
  await expect(page).not.toHaveURL(/app=library/)
  await expect(chatRail(page)).toHaveCount(0)
  await expect(devRail(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(libraryRail(page)).not.toHaveAttribute('aria-pressed', 'true')
})

test('the library search and enabled-only filter survive leaving and returning, and reset on reload', async ({
  page,
}) => {
  await openShell(page, '/')
  await openLibrary(page)
  const search = page.getByRole('searchbox', { name: 'Search apps' })
  const enabledOnly = page.getByRole('button', { name: 'Show enabled only', exact: true })
  await search.fill('dev')
  await enabledOnly.click()
  await expect(enabledOnly).toHaveAttribute('aria-pressed', 'true')

  // Leave through the one tile the filter keeps visible, then return with Back.
  await page.getByRole('button', { name: 'Open Dev', exact: true }).click()
  await expect(page).not.toHaveURL(/app=library/)
  await expect(devRail(page)).toHaveAttribute('aria-pressed', 'true')
  await page.goBack()
  await expect(page).toHaveURL(/app=library/)
  await expect(search).toHaveValue('dev')
  await expect(enabledOnly).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Open Dev', exact: true })).toBeVisible()

  // A reload starts a new session, so the search and filter are back to their defaults.
  await page.reload()
  await expect(page.getByRole('searchbox', { name: 'Search apps' })).toHaveValue('')
  await expect(
    page.getByRole('button', { name: 'Show enabled only', exact: true })
  ).toHaveAttribute('aria-pressed', 'false')
})
