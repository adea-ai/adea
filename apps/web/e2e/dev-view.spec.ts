import { expect, test } from '@playwright/test'

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
    await expect(page).toHaveURL(/devE2e=preserved/)

    if (width <= 768) {
      const sidebarToggle = page.getByRole('button', { name: 'Toggle projects sidebar' })
      await sidebarToggle.click()
      await expect(page.getByRole('complementary', { name: 'Projects and sessions' })).toBeVisible()
      const utilitiesToggle = page.getByRole('button', { name: 'Agents / History' })
      await utilitiesToggle.click()
      await expect(
        page.getByRole('complementary', { name: 'Developer utilities (right)' })
      ).toBeVisible()
    } else {
      await expect(page.getByRole('complementary', { name: 'Projects and sessions' })).toBeVisible()
    }
  })
}

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

  await page.getByRole('button', { name: 'Other project session' }).click()
  await expect(page.getByRole('button', { name: 'Other project session' })).toHaveAttribute(
    'aria-current',
    'page'
  )

  const group = page.getByRole('button', { name: 'PRODUCT' })
  await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'false')

  const separator = page.getByRole('separator', { name: 'Resize workspace panes' })
  await separator.focus()
  await page.keyboard.press('ArrowRight')
  await expect(separator).toHaveAttribute('aria-valuenow', '55')

  await page.getByRole('button', { name: 'Split pane' }).click()
  await expect(page.getByRole('separator', { name: 'Resize workspace panes' })).toHaveCount(2)
  await page.getByRole('button', { name: 'Close terminal pane' }).last().click()
  await expect(page.getByRole('region', { name: 'editor pane' })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Undo close' })).toBeEnabled()
  await page.getByRole('button', { name: 'Undo close' }).click()
  await expect(page.getByRole('separator', { name: 'Resize workspace panes' })).toHaveCount(2)

  await page.getByRole('button', { name: 'Enter focus mode' }).click()
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Exit focus mode' })).toBeFocused()
  await page.getByRole('button', { name: 'Exit focus mode' }).click()

  const rightUtilities = page.getByRole('complementary', { name: 'Developer utilities (right)' })
  const leftUtilities = page.getByRole('complementary', { name: 'Developer utilities (left)' })
  await expect(leftUtilities).toBeVisible()
  await page.getByRole('button', { name: 'Agents / History' }).click()
  await expect(rightUtilities.getByRole('heading', { name: 'Agents' })).toBeVisible()
  await rightUtilities.getByRole('tab', { name: 'Agents' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(rightUtilities.getByRole('tab', { name: 'History' })).toBeFocused()
  await expect(rightUtilities.getByRole('heading', { name: 'History' })).toBeVisible()

  // Both slots stay independent: collapsing the left side never hides the
  // right side and the reverse holds after reopening.
  await page.getByRole('button', { name: 'Files / SC' }).click()
  await expect(leftUtilities).toBeHidden()
  await expect(rightUtilities).toBeVisible()
  await expect(rightUtilities.getByRole('tab', { name: 'History' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.getByRole('button', { name: 'Files / SC' }).click()
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
  await expect(panes).toHaveCount(2, { timeout: 30_000 })
  await expect(panes.first()).toHaveAttribute('data-pane-id', 'dev-terminal')

  await page.getByRole('region', { name: 'terminal pane' }).click()
  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight')
  await expect(panes.first()).toHaveAttribute('data-pane-id', 'dev-editor')
  await expect(page.getByRole('region', { name: 'terminal pane' })).toBeFocused()

  await page.keyboard.press('ControlOrMeta+Alt+ArrowLeft')
  await expect(panes.first()).toHaveAttribute('data-pane-id', 'dev-terminal')

  await expect(page.getByRole('button', { name: 'New session' })).toBeDisabled()
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
  await page.getByRole('button', { name: 'Toggle projects sidebar' }).click()
  await expect(page.getByRole('complementary', { name: 'Projects and sessions' })).toBeVisible()

  // Keyboard-only path: the skip link is focusable and utility tab arrows land.
  await page.getByRole('link', { name: 'Skip to workspace' }).focus()
  await expect(page.getByRole('link', { name: 'Skip to workspace' })).toBeFocused()
  await page.getByRole('button', { name: 'Agents / History' }).click()
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

  const snapshot = await page.locator('main').ariaSnapshot()
  expect(snapshot).toContain('Skip to workspace')
  expect(snapshot).toContain('Developer workspace actions')
  expect(snapshot).toContain('Projects and sessions')

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: 'Files / SC' }).click()
  await page.getByRole('button', { name: 'Files / SC' }).click()
  expect(errors).toEqual([])
})
