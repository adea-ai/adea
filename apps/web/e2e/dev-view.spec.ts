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

  await page.getByRole('button', { name: 'Agents / History' }).click()
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible()
  await page.getByRole('tab', { name: 'Agents' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'History' })).toBeFocused()
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible()
  await page.getByRole('button', { name: 'Expand utility pane' }).click()
  await expect(page.getByRole('button', { name: 'Restore utility pane' })).toBeVisible()

  await page.getByRole('button', { name: 'Chat view' }).click()
  await expect(page).toHaveURL(/view=chat/)
  await expect(page).toHaveURL(/sentinel=keep/)
  await page.goBack()
  await expect(page).toHaveURL(/view=dev/)
  await expect(page.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: 'Restore utility pane' })).toBeVisible()
  await page.getByRole('button', { name: 'Restore utility pane' }).click()
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(
    page
      .getByRole('separator', { name: 'Resize workspace panes' })
      .and(page.locator('[aria-valuenow="55"]'))
  ).toHaveCount(1)
})
