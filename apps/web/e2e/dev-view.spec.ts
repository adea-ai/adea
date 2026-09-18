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
  await expect(page.getByText('No runtime projects available.')).toBeVisible()
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
  await expect(row).toBeVisible()
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
  await expect(panes).toHaveCount(2)
  await expect(panes.first()).toHaveAttribute('data-pane-id', 'dev-terminal')

  await page.getByRole('region', { name: 'terminal pane' }).click()
  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight')
  await expect(panes.first()).toHaveAttribute('data-pane-id', 'dev-editor')
  await expect(page.getByRole('region', { name: 'terminal pane' })).toBeFocused()

  await page.keyboard.press('ControlOrMeta+Alt+ArrowLeft')
  await expect(panes.first()).toHaveAttribute('data-pane-id', 'dev-terminal')

  await expect(page.getByRole('button', { name: 'New session' })).toBeDisabled()
})
