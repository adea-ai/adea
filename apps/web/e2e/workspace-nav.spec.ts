import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

async function openHarness(page: Page, query = '') {
  const path = `/__workspace-nav${query}`
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
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-nav-harness-app.tsx')
  )
  await expect(page.getByRole('tree', { name: /projects$/ })).toBeVisible()
}

const events = (page: Page) => page.getByRole('list', { name: 'Nav events' })
const nav = (page: Page) => page.getByRole('navigation', { name: 'Workspace', exact: true })

test('the sidebar shows the selected workspace alone, under a Projects heading', async ({
  page,
}) => {
  await openHarness(page)
  await expect(nav(page).getByRole('heading', { name: 'Projects' })).toBeVisible()
  await expect(nav(page)).toHaveAttribute('data-workspace-id', 'adea-ws')
  await expect(page.getByRole('tree', { name: 'Adea projects' })).toBeVisible()
  // No other workspace, no cross-workspace counts, no workspace creation here.
  for (const other of ['Pink Binder', 'Nifty League', 'Personal'])
    await expect(nav(page).getByText(other)).toHaveCount(0)
  await expect(nav(page).getByText('Across your workspaces')).toHaveCount(0)
  await expect(nav(page).getByRole('button', { name: 'New workspace' })).toHaveCount(0)

  await openHarness(page, '?workspace=pink-binder')
  await expect(page.getByRole('tree', { name: 'Pink Binder projects' })).toBeVisible()
  await expect(page.getByRole('tree', { name: 'Adea projects' })).toHaveCount(0)
})

test('Add project is a folder-plus button beside the grouping control', async ({ page }) => {
  await openHarness(page)
  const add = nav(page).getByRole('button', { name: 'Add project', exact: true })
  await expect(add).toBeVisible()
  await expect(add.locator('svg.lucide-folder-plus')).toHaveCount(1)
  await add.click()
  await expect(events(page)).toContainText('add-project')
})

test('projects are independent accordion groups: opening one never closes another', async ({
  page,
}) => {
  await openHarness(page)
  const tree = page.getByRole('tree', { name: 'Adea projects' })
  const adea = tree.locator('[data-project-id="adea"]')
  const ui = tree.locator('[data-project-id="adea-ui"]')
  await expect(adea).toHaveAttribute('aria-expanded', 'true')
  await expect(ui).toHaveAttribute('aria-expanded', 'true')

  // Clicking the row (not an action button) toggles only that project.
  await adea.click()
  await expect(adea).toHaveAttribute('aria-expanded', 'false')
  await expect(ui).toHaveAttribute('aria-expanded', 'true')
  await expect(events(page)).toContainText('collapse:adea')
  await expect(events(page)).not.toContainText('collapse:adea-ui')

  // Expanding it again, and selecting a session in the other, collapses nothing.
  await adea.click()
  await expect(adea).toHaveAttribute('aria-expanded', 'true')
  await page.locator('[data-leaf-id="sidebar-tree-primitive"]').click()
  await expect(events(page)).toContainText('leaf:sidebar-tree-primitive')
  await expect(adea).toHaveAttribute('aria-expanded', 'true')
  await expect(ui).toHaveAttribute('aria-expanded', 'true')
})

test('project action buttons act on their own and never toggle the row', async ({ page }) => {
  await openHarness(page)
  const tree = page.getByRole('tree', { name: 'Adea projects' })
  const adea = tree.locator('[data-project-id="adea"]')
  await adea.hover()
  await adea.getByRole('button', { name: 'New session in adea' }).click()
  await expect(events(page)).toContainText('create-leaf:adea')
  await adea.hover()
  await adea.getByRole('button', { name: 'Project settings for adea' }).click()
  await expect(events(page)).toContainText('project-settings:adea')
  await expect(adea).toHaveAttribute('aria-expanded', 'true')
  await expect(events(page)).not.toContainText('collapse:adea')
})

test('group-by switches between project, status and recent renderings', async ({ page }) => {
  await openHarness(page)
  const tree = page.getByRole('tree', { name: 'Adea projects' })
  await page.getByRole('button', { name: /Group by/ }).click()
  await page.getByRole('menuitemradio', { name: /Status/ }).click()
  await expect(events(page)).toContainText('group:status')
  await expect(tree.locator('[data-status-group]')).toHaveText([
    /^Needs you\s*1$/,
    /^Running\s*2$/,
    /^In review\s*1$/,
    /^Idle\s*4$/,
  ])
  await expect(tree.getByRole('treeitem', { name: 'Needs you 1' })).toHaveAttribute(
    'aria-expanded',
    'true'
  )

  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.getByRole('button', { name: /Group by/ }).click()
  await expect(page.getByRole('menuitemradio', { name: /Status/ })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await page.getByRole('menuitemradio', { name: /Recent/ }).click()
  await expect(events(page)).toContainText('group:recent')
  await expect(tree.getByRole('treeitem').first()).toContainText('sidebar-ux-redesign')
})

test('row menus come from the adapter and the checkout has no delete', async ({ page }) => {
  await openHarness(page)
  await page.getByRole('treeitem', { name: /sidebar-ux-redesign/ }).hover()
  await page.getByRole('button', { name: 'Worktree options for sidebar-ux-redesign' }).click()
  await expect(page.getByRole('menuitem')).toHaveText([
    'Rename',
    'Copy link',
    'Share',
    'Open in Finder',
    'Archive',
    'Delete',
  ])
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(events(page)).toContainText('leaf-menu:archive:sidebar-ux-redesign')

  const checkout = page.locator('[data-leaf-id="adea-main"]')
  await checkout.hover()
  await checkout.getByRole('button', { name: 'Worktree options for main' }).click()
  await expect(page.getByRole('menuitem')).toHaveText(['Copy path', 'Open in Finder', 'Share'])
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Renaming and every other setting live in project settings; the menu keeps
  // only what changes who sees the project or whether it exists.
  await page.locator('[data-project-id="adea"]').hover()
  await page.getByRole('button', { name: 'Project options for adea', exact: true }).click()
  await expect(page.getByRole('menuitem')).toHaveText(['Share', 'Archive', 'Delete'])
})

test('the tree supports keyboard navigation, disclosure and selection', async ({ page }) => {
  await openHarness(page)
  const tree = page.getByRole('tree', { name: 'Adea projects' })
  const project = tree.locator('[data-project-id="adea"]')
  await project.focus()
  await expect(project).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(project).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('[data-leaf-id="adea-main"]')).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(project).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowDown')
  const checkout = page.locator('[data-leaf-id="adea-main"]')
  await expect(checkout).toBeFocused()
  await page.keyboard.press('ArrowDown')
  const worktree = page.locator('[data-leaf-id="sidebar-ux-redesign"]')
  await expect(worktree).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(events(page)).toContainText('leaf:sidebar-ux-redesign')
  await expect(worktree).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(project).toBeFocused()
})

test('the Projects heading actions stay visible without hover or focus', async ({ page }) => {
  await openHarness(page)
  await page.mouse.move(0, 0)
  for (const name of [/^Group by/, /^Add project$/]) {
    const action = nav(page).getByRole('button', { name })
    await expect(action).toBeVisible()
    await expect
      .poll(() =>
        action.evaluate((element) => {
          // Every ancestor up to the nav must be fully opaque.
          let node: Element | null = element
          while (node && node.getAttribute('data-slot') !== 'workspace-nav') {
            if (getComputedStyle(node).opacity !== '1') return false
            node = node.parentElement
          }
          return true
        })
      )
      .toBe(true)
  }
})
