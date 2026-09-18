import { expect, test, type Page } from '@playwright/test'

async function openAppearance(page: Page) {
  await page.getByRole('button', { name: 'Appearance' }).click()
  const dialog = page.getByRole('dialog', { name: 'Appearance' })
  await expect(dialog).toBeVisible()
  return dialog
}

function section(dialog: ReturnType<Page['getByRole']>, label: string) {
  return dialog.locator(`section[aria-label="${label}"]`)
}

test.describe('appearance', () => {
  test.beforeEach(async ({ page }) => {
    // A pinned preference from a previous visit must not leak between
    // scenarios: every test starts from the default appearance. The guard
    // keeps the cleanup to the first document, so a reload inside the test
    // still exercises the persisted preference.
    await page.addInitScript(() => {
      if (window.sessionStorage.getItem('appearance-scenario-cleaned') === '1') return
      window.localStorage.removeItem('appearance')
      window.localStorage.removeItem('theme')
      window.sessionStorage.setItem('appearance-scenario-cleaned', '1')
    })
    await page.goto('/?view=chat')
    await expect(page.getByRole('main')).toBeVisible()
  })

  test('mode and theme changes preview live and Save persists them', async ({ page }) => {
    const dialog = await openAppearance(page)

    await section(dialog, 'Appearance mode').getByRole('radio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)

    await section(dialog, 'Dark theme').getByRole('radio', { name: 'Slate Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'slate-dark')

    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'slate-dark')

    // The saved preference survives a reload through the pre-paint script.
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'slate-dark')
    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  test('Escape reverts the draft: closing without saving keeps the old appearance', async ({
    page,
  }) => {
    const dialog = await openAppearance(page)
    await section(dialog, 'Appearance mode').getByRole('radio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    expect(await page.evaluate(() => window.localStorage.getItem('appearance'))).toBeNull()
  })

  test('reduced transparency forces the opaque surface state', async ({ page }) => {
    const dialog = await openAppearance(page)
    await dialog.getByRole('switch', { name: 'Reduce transparency' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-reduce-transparency', 'true')
    await expect(dialog.getByText('Reduced transparency is active')).toBeVisible()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-reduce-transparency', 'true')
  })

  test('appearance is keyboard-operable with radiogroup arrow keys', async ({ page }) => {
    const dialog = await openAppearance(page)
    const mode = section(dialog, 'Appearance mode')
    await mode.getByRole('radio', { name: 'System' }).click()
    await page.keyboard.press('ArrowRight')
    await expect(mode.getByRole('radio', { name: 'Light' })).toBeChecked()
    await page.keyboard.press('ArrowRight')
    await expect(mode.getByRole('radio', { name: 'Dark' })).toBeChecked()
  })

  test('the legacy single theme key migrates without flash or deletion', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('theme', 'dark')
    })
    await page.reload()
    await expect(page.locator('html')).toHaveClass(/dark/)
    expect(await page.evaluate(() => window.localStorage.getItem('theme'))).toBe('dark')
    expect(await page.evaluate(() => window.localStorage.getItem('appearance'))).toBeNull()
  })
})

async function openNavigationTab(page: Page) {
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  await rail.getByRole('button', { name: 'App Library' }).click()
  const library = page.getByRole('dialog', { name: 'App Library' })
  await expect(library).toBeVisible()
  await library.getByRole('tab', { name: /Navigation/ }).click()
  return { rail, library }
}

test.describe('rail customization', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.removeItem('adea:rail-preferences:v1')
    })
    await page.goto('/?view=chat')
    await expect(page.getByRole('main')).toBeVisible()
  })

  test('optional views hide, stay recoverable, and Reset Navigation restores them', async ({
    page,
  }) => {
    const rail = page.getByRole('navigation', { name: 'Global navigation' })
    await expect(rail.getByRole('button', { name: 'Virtual view' })).toBeVisible()

    let { library } = await openNavigationTab(page)
    const virtualRow = library
      .getByRole('listitem')
      .filter({ has: page.getByText('Virtual view', { exact: true }) })
    await virtualRow.getByRole('checkbox').uncheck()
    await expect(virtualRow.getByRole('checkbox')).not.toBeChecked()

    await library.getByRole('button', { name: 'Reset Navigation' }).click()
    await expect(virtualRow.getByRole('checkbox')).toBeChecked()
    await page.keyboard.press('Escape')
    await expect(library).toBeHidden()

    // Hide Dev for real this time, then prove it is recoverable.
    ;({ library } = await openNavigationTab(page))
    const devRow = library
      .getByRole('listitem')
      .filter({ has: page.getByText('Dev view', { exact: true }) })
    await devRow.getByRole('checkbox').uncheck()
    await page.keyboard.press('Escape')
    await expect(library).toBeHidden()
    await expect(rail.getByRole('button', { name: 'Dev view' })).toBeHidden()

    ;({ library } = await openNavigationTab(page))
    await devRow.getByRole('checkbox').check()
    await page.keyboard.press('Escape')
    await expect(library).toBeHidden()
    await expect(rail.getByRole('button', { name: 'Dev view' })).toBeVisible()
  })

  test('the active view cannot disappear even when its entry is hidden', async ({ page }) => {
    const rail = page.getByRole('navigation', { name: 'Global navigation' })
    const { library } = await openNavigationTab(page)
    const chatRow = library
      .getByRole('listitem')
      .filter({ has: page.getByText('Chat view', { exact: true }) })
    await chatRow.getByRole('checkbox').uncheck()
    await page.keyboard.press('Escape')
    await expect(library).toBeHidden()
    // Chat is the active view; the rail keeps it rendered.
    await expect(rail.getByRole('button', { name: 'Chat view' })).toBeVisible()
  })
})
