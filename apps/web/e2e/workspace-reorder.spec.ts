// Reordering workspaces from the top bar's workspace menu.
//
// The menu's "Reorder workspaces…" dialog lists the member's workspaces with a
// Move up and Move down on each row, keeps the personal workspace first, and
// saves every move through POST /api/workspaces/reorder. The spec mocks every
// workspace API response, so no database is needed; the route itself is held
// by the integration lane.
import { expect, test, type Page } from '@playwright/test'

const timestamp = '2026-09-22T10:00:00.000Z'
const workspace = (id: string, name: string, sortOrder: number, isPersonal = false) => ({
  id,
  name,
  scene: isPersonal ? 'home' : 'work',
  accent: null,
  isPersonal,
  logo: { kind: 'monogram' as const },
  sortOrder,
  version: 1,
  updatedAt: timestamp,
})
const initial = [
  workspace('ws-home', 'Home', 0, true),
  workspace('ws-alpha', 'Alpha', 1),
  workspace('ws-beta', 'Beta', 2),
]

async function mockWorkspaces(page: Page) {
  const saved: string[][] = []
  let current = initial
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('adea:e2e-initialized')) {
      localStorage.clear()
      localStorage.setItem('theme', 'light')
      localStorage.setItem(
        'adea:rail-preferences:v1',
        JSON.stringify({ version: 1, order: ['virtual', 'chat', 'dev', 'kanban'], hidden: [] })
      )
      sessionStorage.setItem('adea:e2e-initialized', 'true')
    }
  })
  await page.route('**/api/workspaces/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        activeWorkspace: initial[1],
        principal: { temporary: true, userId: 'reorder-e2e-user' },
        workspaces: current,
      },
    })
  )
  await page.route('**/api/workspaces/reorder', async (route) => {
    const body = route.request().postDataJSON() as { workspaceIds: string[] }
    saved.push(body.workspaceIds)
    current = body.workspaceIds.map((id, index) => ({
      ...initial.find((item) => item.id === id)!,
      sortOrder: index,
    }))
    await route.fulfill({ contentType: 'application/json', json: current })
  })
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
  return saved
}

const switcher = (page: Page) => page.getByRole('button', { name: /^Switch workspace, current:/ })
const menuOrder = async (page: Page) => {
  await switcher(page).click()
  const names = await page
    .getByRole('menuitemradio')
    .evaluateAll((items) => items.map((item) => item.textContent?.trim()))
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  return names
}

test('moving a workspace saves the whole order and the menu follows it', async ({ page }) => {
  const saved = await mockWorkspaces(page)
  await page.goto('/', { timeout: 60_000 })
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible({
    timeout: 60_000,
  })
  expect(await menuOrder(page)).toEqual(['Home', 'Alpha', 'Beta'])

  await switcher(page).click()
  await page.getByRole('menuitem', { name: 'Reorder workspaces…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Reorder workspaces' })
  await expect(dialog).toBeVisible()

  // The personal workspace stays first: it has no controls and nothing moves above it.
  await expect(dialog.getByRole('button', { name: /Move Home/ })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Move Alpha up' })).toHaveAttribute(
    'aria-disabled',
    'true'
  )

  await dialog.getByRole('button', { name: 'Move Beta up' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Moved Beta to position 2 of 3.')
  expect(saved).toEqual([['ws-home', 'ws-beta', 'ws-alpha']])
  // Focus stays on the moved row: Beta now sits under the pinned workspace, so its
  // Move up is unavailable and focus lands on the Move down beside it.
  await expect(dialog.getByRole('button', { name: 'Move Beta down' })).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await menuOrder(page)).toEqual(['Home', 'Beta', 'Alpha'])
})

test('a rejected save shows an error and keeps the order', async ({ page }) => {
  await mockWorkspaces(page)
  await page.route('**/api/workspaces/reorder', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      json: {
        code: 'workspace_order_conflict',
        message: 'Your workspace list changed. Refresh it and try again.',
      },
    })
  )
  await page.goto('/', { timeout: 60_000 })
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible({
    timeout: 60_000,
  })
  await switcher(page).click()
  await page.getByRole('menuitem', { name: 'Reorder workspaces…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Reorder workspaces' })
  await dialog.getByRole('button', { name: 'Move Beta up' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Could not save the order. Try again.')
  await expect(dialog.getByRole('listitem').first()).toContainText('Home')
  await dialog.getByRole('button', { name: 'Dismiss' }).click()
  expect(await menuOrder(page)).toEqual(['Home', 'Alpha', 'Beta'])
})
