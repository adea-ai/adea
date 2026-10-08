// Source control in the production workspace shell: the view's top bar keeps
// the left-side boundary every other view obeys. The leading section's
// vertical divider lands on the contextual sidebar's right edge while that
// sidebar is inline, everything scene-specific (the pull-request search that
// leads the group, the sync status, and the sync control) sits strictly right
// of it, and a collapsed or drawer-presented sidebar collapses the boundary
// back in flow after the leading controls — the exact geometry the Dev view's
// gate pins.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const path = '/__workspace-navigation-presentation-harness'

declare global {
  interface Window {
    workspaceNavigationPresentationHarness: Record<string, unknown>
  }
}

/** Load the production WorkspaceNavigation harness; it boots into the Dev view. */
async function openShellHarness(page: Page) {
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head></head><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  const app = resolve(
    process.cwd(),
    'apps/web/e2e/helpers/workspace-navigation-presentation-harness-app.tsx'
  )
  await page.addScriptTag({ type: 'module', content: `import '${'/@fs' + app}'` })
  await page.waitForFunction(() => Boolean(window.workspaceNavigationPresentationHarness), null, {
    timeout: 120_000,
  })
}

async function openShellWithSourceControl(page: Page) {
  await openShellHarness(page)
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  await page.getByRole('button', { name: 'Enable Source control', exact: true }).click()
  await page.getByRole('button', { name: 'Open Source control', exact: true }).click()
  // The harness router uses a memory history, so the switch shows in the
  // surface, not the address bar.
  await expect(page.getByRole('complementary', { name: 'Accounts and projects' })).toBeVisible()
}

async function bounds(locator: Locator, label: string) {
  const box = await locator.boundingBox()
  if (!box) throw new Error(`${label} has no visible bounds`)
  return box
}

async function expectBoundary(page: Page, width: number) {
  const navigation = page.locator('[data-topbar-navigation]')
  const divider = navigation.locator('[data-topbar-view-divider]')
  const sidebar = page.locator('.dev-scm .dev-sidebar')
  const rail = page.locator('[data-global-rail]')
  const leadingControls = [
    navigation.getByRole('button', { name: 'Back', exact: true }),
    navigation.getByRole('button', { name: 'Forward', exact: true }),
    navigation.getByRole('button', { name: /^(Collapse|Expand) contextual sidebar$/ }),
  ]
  const sceneControls = [
    page.locator('.dev-scm-topbar__synced'),
    page.getByRole('button', { name: 'Sync now' }),
  ]
  const search = page.locator('[data-scm-search]')

  const [dividerBounds, railBounds, ...controlBounds] = await Promise.all([
    bounds(divider, 'Source control divider'),
    bounds(rail, 'Global rail'),
    ...leadingControls.map((control, index) => bounds(control, `Leading control ${index + 1}`)),
  ])
  const leadingEnd = Math.max(...controlBounds.map((box) => box.x + box.width))
  const inlineSidebar = width > 768 && (await sidebar.isVisible())
  const sidebarEdge = inlineSidebar
    ? ((box) => box.x + box.width)(await bounds(sidebar, 'Sidebar'))
    : 0

  if (inlineSidebar) {
    // Inline sidebar: the divider lines up with its right edge exactly.
    expect(Math.abs(dividerBounds.x - sidebarEdge)).toBeLessThanOrEqual(1)
  } else {
    // Collapsed or drawer-presented sidebar: the boundary falls back in flow
    // after the leading controls and the outer rail.
    expect(dividerBounds.x).toBeGreaterThanOrEqual(
      Math.max(sidebarEdge, railBounds.x + railBounds.width, leadingEnd) - 1
    )
  }

  // Everything scene-specific lives strictly right of the divider.
  for (const sceneControl of [sceneControls[0], sceneControls[1]]) {
    if ((await sceneControl.isVisible()) === false) continue
    const box = await bounds(sceneControl, 'Scene control')
    expect(box.x).toBeGreaterThanOrEqual(dividerBounds.x + dividerBounds.width)
  }
  // The pull-request search is scene-specific too; below 48rem the search
  // hides entirely.
  if (width > 768) {
    const searchBounds = await bounds(search, 'Pull-request search')
    expect(searchBounds.x).toBeGreaterThanOrEqual(dividerBounds.x + dividerBounds.width)
    // The search leads the group: it sits entirely left of the sync status.
    const syncedBounds = await bounds(page.locator('.dev-scm-topbar__synced'), 'Sync status')
    expect(searchBounds.x + searchBounds.width).toBeLessThanOrEqual(syncedBounds.x + 1)
  }
}

test('the Dev git pane lays its rows out and sizes its glyphs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  // The presentation harness boots into the Dev view with a worktree that
  // carries a repository, so the pane's remote section renders.
  await openShellHarness(page)
  // The Files slot starts collapsed; open the left utility before switching
  // to the git pane.
  await page
    .locator('.workspace-topbar__view-actions')
    .getByRole('button', { name: 'Expand left utility sidebar', exact: true })
    .click()
  const left = page.getByRole('complementary', { name: 'Developer utilities (left)' })
  await left
    .getByRole('group', { name: 'Files and Source Control' })
    .getByRole('button', { name: 'Source control' })
    .click()
  const pane = left.getByRole('region', { name: 'Source control' })
  await expect(pane).toBeVisible()

  // The header's commit glyph rides the text at the shared inline-icon size,
  // not lucide's unsized 24px default.
  const glyph = pane.locator('.dev-sc__header svg').first()
  await expect(glyph).toBeVisible()
  await expect
    .poll(() => glyph.evaluate((node) => Math.round(node.getBoundingClientRect().width)))
    .toBe(16)

  // Git pane rows are aligned flex rows whose names truncate on their line;
  // before the pane's stylesheet rules existed these were unaligned inline
  // runs.
  const row = pane.locator('.dev-files__row').first()
  await expect(row).toBeVisible()
  await expect.poll(() => row.evaluate((node) => getComputedStyle(node).display)).toBe('flex')
  const name = row.locator('.dev-files__name')
  await expect(name).toBeVisible()
  expect(await name.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('nowrap')

  // Check badges share their run's row instead of wrapping under the name.
  await pane.getByRole('button', { name: 'Load checks' }).click()
  const checkRow = pane.locator('.dev-sc__list .dev-files__row').first()
  await expect(checkRow).toBeVisible()
  await expect
    .poll(() =>
      checkRow.evaluate((node) => {
        const badge = node.querySelector('.dev-files__badge')
        if (!badge) return null
        const rowBox = node.getBoundingClientRect()
        const badgeBox = badge.getBoundingClientRect()
        return badgeBox.top >= rowBox.top && badgeBox.bottom <= rowBox.bottom + 1
      })
    )
    .toBe(true)
})

for (const width of [768, 1024, 1440]) {
  test(`source control top bar keeps the sidebar boundary at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await openShellWithSourceControl(page)
    await expectBoundary(page, width)
    if (width > 768) {
      // Collapsing the contextual sidebar drops the boundary back in flow,
      // exactly like the Dev view.
      await page.getByRole('button', { name: 'Collapse contextual sidebar' }).click()
      await expect(page.locator('.dev-scm .dev-sidebar')).toBeHidden()
      await expectBoundary(page, width)
      await page.getByRole('button', { name: 'Expand contextual sidebar' }).click()
      await expect(page.locator('.dev-scm .dev-sidebar')).toBeVisible()
      await expectBoundary(page, width)
    }
  })
}
