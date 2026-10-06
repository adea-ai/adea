// Source control in the production workspace shell: the view's top bar keeps
// the left-side boundary every other view obeys. The leading section's
// vertical divider lands on the contextual sidebar's right edge while that
// sidebar is inline, everything scene-specific (sync status, sync control,
// and the title-slot pull-request search) sits strictly right of it, and a
// collapsed or drawer-presented sidebar collapses the boundary back in flow
// after the leading controls — the exact geometry the Dev view's gate pins.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const path = '/__workspace-navigation-presentation-harness'

declare global {
  interface Window {
    workspaceNavigationPresentationHarness: Record<string, unknown>
  }
}

async function openShellWithSourceControl(page: Page) {
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
  const navigation = page.locator('.workspace-topbar__navigation')
  const divider = navigation.locator('.workspace-topbar__view-divider')
  const sidebar = page.locator('.dev-scm .dev-sidebar')
  const rail = page.locator('.global-rail')
  const leadingControls = [
    navigation.getByRole('button', { name: 'Back', exact: true }),
    navigation.getByRole('button', { name: 'Forward', exact: true }),
    navigation.getByRole('button', { name: /^(Collapse|Expand) contextual sidebar$/ }),
  ]
  const sceneControls = [
    page.locator('.dev-scm-topbar__synced'),
    page.getByRole('button', { name: 'Sync now' }),
  ]
  const search = page.locator('.dev-scm-topbar__search')

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
  // The title-slot search is scene-specific too; below 48rem the title slot
  // hides entirely.
  if (width > 768) {
    const searchBounds = await bounds(search, 'Title-slot search')
    expect(searchBounds.x).toBeGreaterThanOrEqual(dividerBounds.x + dividerBounds.width)
  }
}

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
