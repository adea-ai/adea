import { expect, test, type Locator, type Page } from '@playwright/test'

async function exerciseContextualSidebarToggle(page: Page) {
  const expandSidebar = page.getByRole('button', { name: 'Expand contextual sidebar', exact: true })
  const collapseSidebar = page.getByRole('button', {
    name: 'Collapse contextual sidebar',
    exact: true,
  })
  const projectsSidebar = page.getByRole('complementary', { name: 'Projects and sessions' })

  if (await expandSidebar.isVisible()) {
    await expect(expandSidebar).toHaveAttribute('aria-expanded', 'false')
    await expect(projectsSidebar).toBeHidden()
    await expandSidebar.click()
    await expect(collapseSidebar).toHaveAttribute('aria-expanded', 'true')
    await expect(collapseSidebar).toBeFocused()
  } else {
    await expect(collapseSidebar).toHaveAttribute('aria-expanded', 'true')
    await expect(projectsSidebar).toBeVisible()
  }

  await expect(projectsSidebar).toBeVisible()
  await collapseSidebar.click()
  await expect(expandSidebar).toHaveAttribute('aria-expanded', 'false')
  await expect(expandSidebar).toBeFocused()
  await expect(projectsSidebar).toBeHidden()
  await expandSidebar.click()
  await expect(collapseSidebar).toHaveAttribute('aria-expanded', 'true')
  await expect(collapseSidebar).toBeFocused()
  await expect(projectsSidebar).toBeVisible()
}

function devToolbarControl(page: Page, name: string) {
  return page.locator('.workspace-topbar__view-actions').getByRole('button', { name, exact: true })
}

async function expectPointerHitsButton(page: Page, button: Locator, name: string) {
  const buttonBounds = await button.boundingBox()
  expect(buttonBounds).not.toBeNull()
  const hitTest = await page.evaluate(
    ({ x, y }) => {
      const describe = (element: Element | null) => {
        if (!(element instanceof HTMLElement)) return null
        const elementBounds = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        const buttonName =
          element.getAttribute('aria-label') ??
          (element instanceof HTMLButtonElement ? element.textContent?.trim() : null)
        return {
          tag: element.tagName.toLowerCase(),
          name: buttonName?.slice(0, 80) ?? null,
          className: element.className,
          rect: {
            x: elementBounds.x,
            y: elementBounds.y,
            width: elementBounds.width,
            height: elementBounds.height,
          },
          containsProbePoint:
            x >= elementBounds.left &&
            x <= elementBounds.right &&
            y >= elementBounds.top &&
            y <= elementBounds.bottom,
          position: style.position,
          zIndex: style.zIndex,
          pointerEvents: style.pointerEvents,
          display: style.display,
          gridTemplateColumns: style.gridTemplateColumns,
          alignItems: style.alignItems,
          justifyItems: style.justifyItems,
        }
      }
      const hitButton = document.elementFromPoint(x, y)?.closest('button') ?? null
      return {
        hitName: hitButton?.getAttribute('aria-label') ?? hitButton?.textContent?.trim() ?? null,
        point: { x, y },
        viewport: { width: innerWidth, height: innerHeight },
        frame: describe(document.querySelector('.workspace-frame')),
        topbar: describe(document.querySelector('.workspace-topbar')),
        surface: describe(document.querySelector('.workspace-frame__surface')),
        workspace: describe(document.querySelector('.dev-workspace')),
        devToolbar: describe(document.querySelector('.dev-toolbar')),
        devActions: describe(document.querySelector('.dev-toolbar__actions')),
        browserButton: describe(document.querySelector('button[aria-label="Browser / Devices"]')),
        hitStack: document.elementsFromPoint(x, y).slice(0, 8).map(describe),
      }
    },
    {
      x: buttonBounds!.x + buttonBounds!.width / 2,
      y: buttonBounds!.y + buttonBounds!.height / 2,
    }
  )
  expect(hitTest.hitName, JSON.stringify(hitTest)).toBe(name)
}

async function expectDevToolbarHost(page: Page) {
  const host = page.locator('.workspace-topbar__view-actions')
  await expect(host).toBeVisible()
  await expect(devToolbarControl(page, 'Enter focus mode')).toBeVisible()
  const fallbackActions = page.locator('.dev-toolbar__actions')
  for (const name of ['Files / SC', 'Browser / Devices', 'Agents / History', 'Enter focus mode']) {
    await expect(fallbackActions.getByRole('button', { name, exact: true })).toHaveCount(0)
  }
}

for (const width of [320, 768, 1280, 1920]) {
  test(`Dev View shell remains usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/?view=dev&devE2e=preserved')
    await expect(page.getByRole('button', { name: 'Dev view', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 20_000 }
    )
    await expect(page.getByRole('main')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible()
    await expectDevToolbarHost(page)
    await expect(page).toHaveURL(/devE2e=preserved/)

    if (width <= 768) {
      await exerciseContextualSidebarToggle(page)
      const utilitiesToggle = devToolbarControl(page, 'Agents / History')
      await utilitiesToggle.click()
      await expect(
        page.getByRole('complementary', { name: 'Developer utilities (right)' })
      ).toBeVisible()
    } else {
      await expect(page.getByRole('complementary', { name: 'Projects and sessions' })).toBeVisible()
    }
  })
}

test('Dev shell stays usable while its central layout loads', async ({ page }) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(/\/layout\/layout-view\.tsx(?:\?|$)/, async (route) => {
    await pending
    await route.continue()
  })
  try {
    await page.goto('/?view=dev&devE2e=preserved')
    await expect(page.getByText('Loading workspace panes…', { exact: true })).toBeVisible()
    await expectDevToolbarHost(page)
    const sidebar = page.getByRole('complementary', { name: 'Projects and sessions' })
    const originalSidebar = await sidebar.elementHandle()
    const session = page.getByRole('button', { name: 'Other project session' })
    await session.click()
    await expect(session).toHaveAttribute('aria-current', 'page')
    release()
    await expect(page.getByRole('region', { name: 'terminal pane' })).toBeVisible()
    await expect(page.getByText('Loading workspace panes…', { exact: true })).toBeHidden()
    await expect(session).toHaveAttribute('aria-current', 'page')
    expect(
      await sidebar.evaluate((element, original) => element === original, originalSidebar)
    ).toBe(true)
    await originalSidebar?.dispose()
  } finally {
    release()
  }
})

test('production unavailable state does not fabricate projects or sessions', async ({ page }) => {
  await page.goto('/?view=dev')
  await expect(page.getByText('No runtime projects available.')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Example project')).toHaveCount(0)
})

test('Dev rail history, hierarchy, separator, focus, and utility controls are deterministic', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved&sentinel=keep')
  await expectDevToolbarHost(page)

  await page.getByRole('button', { name: 'Other project session' }).click()
  await expect(page.getByRole('button', { name: 'Other project session' })).toHaveAttribute(
    'aria-current',
    'page'
  )

  const group = page.getByRole('button', { name: 'PRODUCT' })
  await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'false')

  await expect(page.locator('[data-pane-id]')).toHaveCount(1)
  await expect(page.getByRole('region', { name: 'editor pane' })).toHaveCount(0)
  const splitPane = page.getByRole('button', { name: 'Split pane', exact: true })
  await expectPointerHitsButton(page, splitPane, 'Split pane')
  await splitPane.click()
  // Splitting retains the focused pane's kind (docs/specs/dev-runtime.md), so
  // splitting the lone terminal yields a second terminal, not an editor.
  await expect(page.getByRole('region', { name: 'terminal pane' })).toHaveCount(2)
  await expect(page.getByRole('region', { name: 'editor pane' })).toHaveCount(0)
  const separator = page.getByRole('separator', { name: 'Resize workspace panes' })
  await separator.focus()
  await page.keyboard.press('ArrowRight')
  await expect(separator).toHaveAttribute('aria-valuenow', '55')

  await page.getByRole('button', { name: 'Split pane' }).click()
  await expect(page.getByRole('separator', { name: 'Resize workspace panes' })).toHaveCount(2)
  await page.getByRole('button', { name: 'Close terminal pane' }).last().click()
  await expect(page.locator('[data-pane-id]')).toHaveCount(2)
  // Closing the trailing pane returns focus to the surviving neighbour.
  await expect(page.locator('[data-pane-id="dev-pane-1"]')).toBeFocused()
  await expect(page.getByRole('button', { name: 'Undo close' })).toBeEnabled()
  await page.getByRole('button', { name: 'Undo close' }).click()
  await expect(page.getByRole('separator', { name: 'Resize workspace panes' })).toHaveCount(2)

  const globalNavigation = page.getByRole('navigation', { name: 'Global navigation' })
  const projectsSidebar = page.getByRole('complementary', { name: 'Projects and sessions' })
  const leftUtilities = page.getByRole('complementary', { name: 'Developer utilities (left)' })
  await expect(globalNavigation).toBeVisible()
  await expect(projectsSidebar).toBeVisible()
  await expect(leftUtilities).toBeVisible()

  await devToolbarControl(page, 'Enter focus mode').click()
  const exitFocusMode = devToolbarControl(page, 'Exit focus mode')
  await expect(exitFocusMode).toHaveAttribute('aria-pressed', 'true')
  await expect(exitFocusMode).toBeFocused()
  await expect(globalNavigation).toBeVisible()
  await expect(projectsSidebar).toBeHidden()
  await expect(leftUtilities).toBeHidden()
  await exitFocusMode.click()
  const enterFocusMode = devToolbarControl(page, 'Enter focus mode')
  await expect(enterFocusMode).toHaveAttribute('aria-pressed', 'false')
  await expect(enterFocusMode).toBeFocused()
  await expect(globalNavigation).toBeVisible()
  await expect(projectsSidebar).toBeVisible()
  await expect(leftUtilities).toBeVisible()

  const rightUtilities = page.getByRole('complementary', { name: 'Developer utilities (right)' })
  await devToolbarControl(page, 'Agents / History').click()
  await expect(rightUtilities.getByRole('heading', { name: 'Agents' })).toBeVisible()
  await rightUtilities.getByRole('tab', { name: 'Agents' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(rightUtilities.getByRole('tab', { name: 'History' })).toBeFocused()
  await expect(rightUtilities.getByRole('heading', { name: 'History' })).toBeVisible()

  // Both slots stay independent: collapsing the left side never hides the
  // right side and the reverse holds after reopening.
  await devToolbarControl(page, 'Files / SC').click()
  await expect(leftUtilities).toBeHidden()
  await expect(rightUtilities).toBeVisible()
  await expect(rightUtilities.getByRole('tab', { name: 'History' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await devToolbarControl(page, 'Files / SC').click()
  await expect(leftUtilities).toBeVisible()
  await expect(leftUtilities.getByRole('heading', { name: 'Files' })).toBeVisible()

  await rightUtilities.getByRole('button', { name: 'Expand utility pane' }).click()
  await expect(rightUtilities.getByRole('button', { name: 'Restore utility pane' })).toBeVisible()

  await page.getByRole('button', { name: 'Chat view' }).click()
  await expect(page).toHaveURL(/view=chat/)
  await expect(page).toHaveURL(/sentinel=keep/)
  await page.getByRole('button', { name: 'Dev view' }).click()
  await expect(page).toHaveURL(/view=dev/)
  await expect(rightUtilities.getByRole('tab', { name: 'History' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(rightUtilities.getByRole('button', { name: 'Restore utility pane' })).toBeVisible()
  await rightUtilities.getByRole('button', { name: 'Restore utility pane' }).click()
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(
    page
      .getByRole('separator', { name: 'Resize workspace panes' })
      .and(page.locator('[aria-valuenow="55"]'))
  ).toHaveCount(1)
})

test('session rows show independent state badges without hiding the row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved')
  const row = page.getByRole('button', { name: /Dev View foundation/ })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row.getByTitle('Harness working')).toBeVisible()
  await expect(row.getByTitle('Uncommitted changes')).toBeVisible()
  await expect(row.getByTitle('Checks running')).toBeVisible()
  await expect(row.getByTitle('Owned ports 3000')).toBeVisible()
  const otherRow = page.getByRole('button', { name: /Runtime contracts/ })
  await expect(otherRow).toBeVisible()
  await expect(otherRow.locator('.dev-row-badge')).toHaveCount(0)
})

test('center panes move by keyboard while keeping one primary session', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved')

  const panes = page.locator('[data-pane-id]')
  await expect(panes).toHaveCount(1, { timeout: 30_000 })
  const splitPane = page.getByRole('button', { name: 'Split pane', exact: true })
  await expectPointerHitsButton(page, splitPane, 'Split pane')
  await splitPane.click()
  await expect(panes).toHaveCount(2)
  await expect(panes.first()).toHaveAttribute('data-pane-id', 'dev-terminal')

  await page.locator('[data-pane-id="dev-terminal"]').click()
  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight')
  await expect(panes.first()).toHaveAttribute('data-pane-id', 'dev-pane-1')
  // The moved pane keeps DOM focus as it crosses its sibling.
  await expect(page.locator('[data-pane-id="dev-terminal"]')).toBeFocused()

  await page.keyboard.press('ControlOrMeta+Alt+ArrowLeft')
  await expect(panes.first()).toHaveAttribute('data-pane-id', 'dev-terminal')

  await expect(page.getByRole('button', { name: 'New session' })).toBeDisabled()
})

test('the Dev shell restores the session layout document after a reload', async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page, '/?view=dev&devE2e=preserved')

  await expect(page.locator('[data-pane-id]')).toHaveCount(1)
  const splitPane = page.getByRole('button', { name: 'Split pane', exact: true })
  await expectPointerHitsButton(page, splitPane, 'Split pane')
  await splitPane.click()
  const separator = page.getByRole('separator', { name: 'Resize workspace panes' })
  await separator.focus()
  await page.keyboard.press('ArrowRight')
  await expect(separator).toHaveAttribute('aria-valuenow', '55')

  await devToolbarControl(page, 'Agents / History').click()
  const rightUtilities = page.getByRole('complementary', { name: 'Developer utilities (right)' })
  await expect(rightUtilities).toBeVisible()

  // The layout document is written debounced (250 ms); the reload is the
  // persistence round trip a restart performs, on the same session URL.
  await expect(page).toHaveURL(/devSession=/)
  await page.waitForTimeout(600)
  await page.reload()

  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 60_000,
  })
  await expectDevToolbarHost(page)
  await expect(
    page
      .getByRole('separator', { name: 'Resize workspace panes' })
      .and(page.locator('[aria-valuenow="55"]'))
  ).toHaveCount(1)
  await expect(
    page.getByRole('complementary', { name: 'Developer utilities (right)' })
  ).toBeVisible()
})

test('each utility toggle reveals its pane and the sidebar fills the workspace height', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page, '/?view=dev&devE2e=preserved')

  const leftUtilities = page.getByRole('complementary', { name: 'Developer utilities (left)' })
  const rightUtilities = page.getByRole('complementary', { name: 'Developer utilities (right)' })

  await expect(leftUtilities.getByRole('heading', { name: 'Files' })).toBeVisible()
  await devToolbarControl(page, 'Files / SC').click()
  await expect(leftUtilities).toBeHidden()
  await devToolbarControl(page, 'Files / SC').click()
  await expect(leftUtilities.getByRole('tab', { name: 'Source control' })).toBeVisible()

  await devToolbarControl(page, 'Browser / Devices').click()
  await expect(rightUtilities).toBeVisible()
  await expect(rightUtilities.getByRole('tab', { name: 'Browser' })).toBeVisible()
  await expect(rightUtilities.getByRole('tab', { name: 'Devices' })).toBeVisible()

  await devToolbarControl(page, 'Agents / History').click()
  await expect(rightUtilities.getByRole('heading', { name: 'Agents' })).toBeVisible()

  // The contextual sidebar is a sibling of the center panes and owns the full
  // vertical space of the workspace body rather than its content height.
  const sidebarBox = await page
    .getByRole('complementary', { name: 'Projects and sessions' })
    .boundingBox()
  const panesBox = await page
    .getByRole('region', { name: 'Developer workspace panes' })
    .boundingBox()
  expect(sidebarBox).not.toBeNull()
  expect(panesBox).not.toBeNull()
  expect(Math.abs(sidebarBox!.height - panesBox!.height)).toBeLessThanOrEqual(2)
})

/**
 * Opens the Dev surface and waits for the lazy workspace chunk to mount. On a
 * cold dev server the chunk transform can outrun default expect timeouts, so
 * the first mount wait is generous.
 */
async function openDevView(page: import('@playwright/test').Page, url: string) {
  await page.goto(url)
  await expect(page.getByRole('main')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 60_000,
  })
  await expectDevToolbarHost(page)
}

test('a deep link with a missing session recovers visibly and the URL converges', async ({
  page,
}) => {
  // Cold dev-server transforms of the lazy Dev chunk can be slow on a busy
  // machine; give the whole journey double headroom.
  test.slow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(
    page,
    '/?view=dev&devE2e=preserved&sentinel=keep&devProject=fixture-tools&devSession=ghost-session'
  )
  const banner = page.locator('.dev-recovery-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('no longer available')
  // The corrected selection is written back deterministically; the unknown
  // sentinel key survives every patch.
  await expect(page).toHaveURL(/devProject=fixture-tools/)
  await expect(page).toHaveURL(/devSession=fixture-tools-session/)
  await expect(page).toHaveURL(/sentinel=keep/)
})

test('an archived deep link recovers to a live session without hiding the shelf', async ({
  page,
}) => {
  test.slow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(
    page,
    '/?view=dev&devE2e=preserved&devProject=fixture-tools&devSession=fixture-archived'
  )
  await expect(page.locator('.dev-recovery-banner')).toContainText('archived')
  await expect(page).toHaveURL(/devSession=fixture-tools-session/)
})

test('projects reorder by keyboard with a live announcement and stable focus', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page, '/?view=dev&devE2e=preserved')

  const projectRows = page.locator('.dev-tree-row--project')
  const target = projectRows.filter({ hasText: 'Runtime tools' })
  await target.focus()
  await page.keyboard.press('Alt+ArrowUp')

  await expect(projectRows.first()).toHaveText(/Runtime tools/)
  // The moved row keeps keyboard focus after the tree re-renders.
  const movedRowSelector = `[data-row-id="${'project:fixture-product:fixture-tools'}"]`
  await expect(page.locator(movedRowSelector)).toBeFocused()
  await expect(page.locator('main > [aria-live="polite"]')).toContainText(
    'Runtime tools moved to position 1 of 2'
  )
})

test('projects reorder by pointer drag inside their group', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page, '/?view=dev&devE2e=preserved')

  const projectRows = page.locator('.dev-tree-row--project')
  await expect(projectRows.filter({ hasText: 'Example project' })).toBeVisible()
  await projectRows
    .filter({ hasText: 'Runtime tools' })
    .dragTo(projectRows.filter({ hasText: 'Example project' }))
  await expect(projectRows.first()).toHaveText(/Runtime tools/)
})

test('the archive shelf restores losslessly and deletes only behind an explicit handoff', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page, '/?view=dev&devE2e=preserved')

  await page.getByRole('button', { name: /Archived sessions/ }).click()
  const item = page.locator('.dev-archive-shelf__item', { hasText: 'Archived discovery' })
  await expect(item).toBeVisible()

  // Delete is destructive: it stops at an explicit confirmation step.
  await item.getByRole('button', { name: 'Delete…' }).click()
  const confirm = item.getByRole('alert')
  await expect(confirm).toContainText('Delete this archived session?')
  await confirm.getByRole('button', { name: 'Keep' }).click()
  await expect(item).toBeVisible()

  // Restore is lossless and needs no confirmation.
  await item.getByRole('button', { name: 'Restore' }).click()
  await expect(page.locator('.dev-archive-shelf__item')).toHaveCount(0)

  // Re-archive by deep link, then delete: the commit reports the missing
  // dev.session.delete host contract instead of pretending to succeed.
  await page.goto('/?view=dev&devE2e=preserved&devSession=fixture-archived')
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 60_000,
  })
  await page.getByRole('button', { name: /Archived sessions/ }).click()
  const again = page.locator('.dev-archive-shelf__item', { hasText: 'Archived discovery' })
  await again.getByRole('button', { name: 'Delete…' }).click()
  await again.getByRole('alert').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('.dev-archive-shelf__handoff')).toContainText(
    'dev.session.delete host contract'
  )
})

test('the Dev shell stays keyboard-operable at 200% zoom with reduced motion', async ({ page }) => {
  // 1280x900 at 200% zoom ≈ a 640x450 viewport.
  await page.setViewportSize({ width: 640, height: 450 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?view=dev&devE2e=preserved')
  await expect(page.getByRole('button', { name: 'Dev view', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
    { timeout: 30_000 }
  )
  await exerciseContextualSidebarToggle(page)

  // Keyboard-only path: the skip link is focusable and utility tab arrows land.
  await page.getByRole('link', { name: 'Skip to workspace' }).focus()
  await expect(page.getByRole('link', { name: 'Skip to workspace' })).toBeFocused()
  await devToolbarControl(page, 'Agents / History').click()
  const rightUtilities = page.getByRole('complementary', { name: 'Developer utilities (right)' })
  await expect(rightUtilities.getByRole('heading', { name: 'Agents' })).toBeVisible()
  await rightUtilities.getByRole('tab', { name: 'Agents' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(rightUtilities.getByRole('tab', { name: 'History' })).toBeFocused()
})

test('Dev surfaces expose an aria snapshot and run under an eval-blocking CSP', async ({
  page,
}) => {
  await page.route('**/*', async (route) => {
    const headers = await route.request().allHeaders()
    await route.continue({
      headers: {
        ...headers,
        // Blocks eval/Function without breaking the SSR bootstrap's inline
        // scripts: the Dev surface must be CSP-safe, not inline-free.
        'content-security-policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
      },
    })
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved')
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 60_000,
  })
  await expectDevToolbarHost(page)

  const snapshot = await page.locator('main').ariaSnapshot()
  expect(snapshot).toContain('Skip to workspace')
  expect(snapshot).toContain('Developer workspace actions')
  expect(snapshot).toContain('Projects and sessions')

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await devToolbarControl(page, 'Files / SC').click()
  await devToolbarControl(page, 'Files / SC').click()
  expect(errors).toEqual([])
})
