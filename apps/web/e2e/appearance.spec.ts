import { expect, test, type Page } from '@playwright/test'

async function openAppearance(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Appearance' })
  // Like the App Library dialog, the appearance dialog is code-split; on a
  // cold dev server its chunk transform can outlive the default expect
  // timeout, so retry the open until the dialog settles.
  await expect(async () => {
    await page.getByRole('button', { name: 'Appearance' }).click()
    await expect(dialog).toBeVisible()
  }).toPass({ timeout: 30_000 })
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

    await section(dialog, 'Dark theme').getByRole('button', { name: 'Dark theme' }).click()
    await page.getByRole('menuitemradio', { name: 'Slate Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'slate-dark')
    await expect(section(dialog, 'Dark theme').getByText('Slate Dark')).toBeVisible()

    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'slate-dark')

    // The saved preference survives a reload through the pre-paint script.
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'slate-dark')
    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  test('the mode cards render live miniatures, with System split light/dark', async ({ page }) => {
    const dialog = await openAppearance(page)
    const mode = section(dialog, 'Appearance mode')

    // System's card holds the split (two miniatures); Light and Dark hold one.
    await expect(mode.locator('[data-theme-miniature]')).toHaveCount(4)
    await mode.getByRole('radio', { name: 'Light' }).click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await expect(page.locator('html')).toHaveAttribute('data-appearance-mode', 'light')
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

  test('accent presets and the custom hex picker preview live and normalize', async ({ page }) => {
    const dialog = await openAppearance(page)
    const accent = section(dialog, 'Accent color')

    await accent.getByRole('radio', { name: 'Blue accent' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom')
    await expect(accent.getByText('Blue · Controls, glyphs')).toBeVisible()

    // The custom picker rejects unparseable input and normalizes valid colors.
    await accent.getByRole('radio', { name: 'Custom accent' }).click()
    const hex = accent.getByRole('textbox', { name: 'Custom accent color as a hex value' })
    await hex.fill('not-a-color')
    await hex.blur()
    await expect(accent.getByText('“not-a-color” is not a hex color')).toBeVisible()

    await hex.fill('#2563eb')
    await hex.blur()
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom')
    await accent.getByRole('radio', { name: 'Theme default accent' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'theme')
  })

  test('the glass control switches the resolved surface', async ({ page }) => {
    const dialog = await openAppearance(page)
    await dialog.getByRole('radio', { name: 'Frosted' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'frosted')
    await dialog.getByRole('radio', { name: 'Opaque' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'opaque')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'opaque')
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

  test('the theme library row opens behind the declared-license contract', async ({ page }) => {
    const dialog = await openAppearance(page)
    // An unsaved draft must survive the contract view round-trip.
    await section(dialog, 'Appearance mode').getByRole('radio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await dialog.getByRole('button', { name: 'Add theme' }).click()

    const library = page.getByRole('dialog', { name: 'Add a theme' })
    await expect(library).toBeVisible()
    await expect(library.getByText('declare an explicit license and provenance')).toBeVisible()
    await expect(library.getByText('signed App Library pipeline')).toBeVisible()

    await library.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(library).toBeHidden()
    // The appearance dialog returns with the draft intact and still uncommitted.
    await expect(dialog).toBeVisible()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(
      section(dialog, 'Appearance mode').getByRole('radio', { name: 'Dark' })
    ).toBeChecked()
    expect(await page.evaluate(() => window.localStorage.getItem('appearance'))).toBeNull()
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
  const library = page.getByRole('dialog', { name: 'App Library' })
  // The App Library dialog is code-split and fetched on first open. A cold dev
  // server transforms that chunk on demand and may re-run the dependency
  // optimizer mid-import, which can outlive the default expect timeout or
  // reload the page and drop the panel state — so retry the open until the
  // dialog settles instead of trusting a single click.
  await expect(async () => {
    await rail.getByRole('button', { name: 'App Library' }).click()
    await expect(library).toBeVisible()
  }).toPass({ timeout: 30_000 })
  await library.getByRole('tab', { name: /Navigation/ }).click()
  return { rail, library }
}

test.describe('rail customization', () => {
  // The first rail test after a cold dev-server boot also pays for the
  // on-demand module transforms of the whole workspace shell (the page
  // navigation alone can take half a minute), which does not fit the default
  // per-test budget.
  test.setTimeout(180_000)

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
    // The rail renders once the workspace shell hydrates; on a cold dev server
    // the shell's on-demand module transforms can push that past half a minute
    // (60s matches the boot-latency budget the other specs use for rail waits).
    await expect(rail.getByRole('button', { name: 'Virtual view' })).toBeVisible({
      timeout: 60_000,
    })

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

test('a corrupt stored appearance quarantines into the recovery envelope and survives a save', async ({
  page,
}) => {
  // Seed an unreadable appearance document before the app loads.
  await page.addInitScript(() => {
    window.localStorage.setItem('appearance', '{"version":2,"mode":"da')
  })
  await page.goto('/?view=chat')
  await expect(page.getByRole('main')).toBeVisible()

  // The corrupt value is quarantined byte-for-byte once the provider mounts
  // (hydration is async, so poll instead of reading once).
  let envelope: string | null = null
  await expect
    .poll(
      async () => {
        envelope = await page.evaluate(() => window.localStorage.getItem('appearance.recovery'))
        return envelope
      },
      { timeout: 20_000 }
    )
    .toBeTruthy()
  expect(JSON.parse(envelope!).raw).toBe('{"version":2,"mode":"da')

  // Saving valid preferences must not destroy the quarantined original.
  const dialog = await openAppearance(page)
  await section(dialog, 'Appearance mode').getByRole('radio', { name: 'Dark' }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  const kept = await page.evaluate(() => window.localStorage.getItem('appearance.recovery'))
  expect(JSON.parse(kept!).raw).toBe('{"version":2,"mode":"da')
  expect(
    JSON.parse(await page.evaluate(() => window.localStorage.getItem('appearance')!)).mode
  ).toBe('dark')
})

test('cancel reverts the draft and the OS reduced-motion preference keeps the dialog operable', async ({
  page,
}) => {
  // This test lives outside the describe blocks, so it arranges its own page:
  // a pinned preference from another scenario must not leak in, and the
  // workspace must be loaded before the rail can open the dialog.
  await page.addInitScript(() => {
    window.localStorage.removeItem('appearance')
    window.localStorage.removeItem('theme')
  })
  await page.goto('/?view=chat')
  await expect(page.getByRole('main')).toBeVisible()

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const dialog = await openAppearance(page)

  await section(dialog, 'Appearance mode').getByRole('radio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  // Closing without saving restores the pre-open appearance.
  await expect(page.locator('html')).not.toHaveClass(/dark/)

  // Re-open under reduced motion: live previews still apply.
  const reopened = await openAppearance(page)
  await section(reopened, 'Appearance mode').getByRole('radio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await reopened.getByRole('button', { name: 'Cancel' }).click()
})
