import { expect, test, type Page } from '@playwright/test'

/**
 * The appearance editor lives in the settings dialog's Appearance section (the
 * global rail no longer carries its own entry, #425). It is reached the way a
 * user reaches it — account menu, Settings, then the section — rather than by
 * hash: the section is read from the hash on mount, and the app normalizes the
 * URL, so a hash navigation from an already-loaded page is not a path the app
 * promises to honour. The editor chunk is code-split, so a cold dev server can
 * outlive the default expect timeout and the whole path is retried.
 */
async function openAppearance(page: Page) {
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const panel = settings.getByRole('region', { name: 'Appearance', exact: true })
  await expect(async () => {
    // Idempotent on purpose: a test may ask again while the section is already
    // on screen, and the account menu sits behind the open dialog.
    if (await panel.isVisible().catch(() => false)) return
    if (!(await settings.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: 'User settings' }).click()
      await page.getByRole('menuitem', { name: 'Settings' }).click()
    }
    await settings.getByRole('tab', { name: 'Appearance' }).click()
    await expect(panel).toBeVisible()
  }).toPass({ timeout: 30_000 })
  return panel
}

function editor(panel: ReturnType<Page['getByRole']>) {
  return panel.locator('[data-appearance-editor]')
}

function modeGroup(panel: ReturnType<Page['getByRole']>) {
  return editor(panel).getByRole('radiogroup', { name: 'Appearance mode' })
}

function accentGroup(panel: ReturnType<Page['getByRole']>) {
  return editor(panel).getByRole('radiogroup', { name: 'Accent' })
}

function themeRow(panel: ReturnType<Page['getByRole']>, label: 'Light theme' | 'Dark theme') {
  return editor(panel)
    .locator('section')
    .filter({ has: panel.getByRole('heading', { name: label }) })
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
    const panel = await openAppearance(page)

    await modeGroup(panel).getByText('Dark', { exact: true }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)

    await editor(panel).getByText('Adea Dark', { exact: true }).click()
    await page.getByRole('option', { name: 'Slate Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'slate-dark')
    await expect(editor(panel).getByRole('button', { name: 'Dark theme Slate Dark' })).toBeVisible()

    await panel.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'slate-dark')

    // The saved preference survives a reload through the pre-paint script.
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'slate-dark')
    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  test('Light mode applies, saves, and survives a reload against a dark OS', async ({ page }) => {
    // Reported as "unable to enable light mode": pinned Light must beat the
    // host's dark appearance, keep doing so through a save, and survive a
    // reload through the pre-paint script.
    await page.emulateMedia({ colorScheme: 'dark' })
    const panel = await openAppearance(page)

    await modeGroup(panel).getByText('Light', { exact: true }).click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await expect(page.locator('html')).toHaveAttribute('data-appearance-mode', 'light')

    await panel.getByRole('button', { name: 'Save' }).click()
    await page.reload()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await expect(page.locator('html')).toHaveAttribute('data-appearance-mode', 'light')
  })

  test('the mode cards render live miniatures, with System split light/dark', async ({ page }) => {
    const panel = await openAppearance(page)
    const mode = modeGroup(panel)

    // System's card holds the split (two miniatures); Light and Dark hold one.
    await expect(mode.locator('[data-theme-miniature]')).toHaveCount(4)
    await mode.getByText('Light', { exact: true }).click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await expect(page.locator('html')).toHaveAttribute('data-appearance-mode', 'light')
  })

  test('Escape reverts the draft: leaving the section without saving keeps the old appearance', async ({
    page,
  }) => {
    const panel = await openAppearance(page)
    await modeGroup(panel).getByText('Dark', { exact: true }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    expect(await page.evaluate(() => window.localStorage.getItem('appearance'))).toBeNull()
  })

  test('accent presets and the custom hex picker preview live and normalize', async ({ page }) => {
    const panel = await openAppearance(page)
    const accent = accentGroup(panel)

    await accent.getByRole('radio', { name: 'Blue' }).press('Space')
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom')
    await expect(
      editor(panel).getByText('Blue · Controls, glyphs, selections, code, and activity.')
    ).toBeVisible()

    // The custom picker rejects unparseable input and normalizes valid colors.
    await accent.getByRole('radio', { name: 'Custom' }).press('Space')
    const hex = editor(panel).getByRole('textbox', { name: 'Custom accent' })
    await hex.fill('not-a-color')
    await hex.blur()
    await expect(hex).toHaveValue('not-a-color')
    await expect(editor(panel).getByText('“not-a-color” is not a hex color such as #2563eb.')).toBeVisible()

    await hex.fill('#2563eb')
    await hex.blur()
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom')
    await accent.getByRole('radio', { name: 'Theme default' }).press('Space')
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'theme')
  })

  test('the glass control switches the resolved surface', async ({ page }) => {
    const panel = await openAppearance(page)
    await panel.getByText('Frosted', { exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'frosted')
    await panel.getByText('Opaque', { exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'opaque')
    // Leave the draft on a value that differs from what is committed: Save only
    // exists while there is something to save.
    await panel.getByText('Frosted', { exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'frosted')
    await panel.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'frosted')
  })

  test('reduced transparency forces the opaque surface state', async ({ page }) => {
    const panel = await openAppearance(page)
    await panel.getByRole('switch', { name: 'Reduce transparency' }).press('Space')
    await expect(page.locator('html')).toHaveAttribute('data-reduce-transparency', 'true')
    await expect(panel.getByText('Prefer solid surfaces, including during live preview.')).toBeVisible()
    await panel.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-reduce-transparency', 'true')
  })

  test('appearance is keyboard-operable with radiogroup arrow keys', async ({ page }) => {
    const panel = await openAppearance(page)
    const mode = modeGroup(panel)
    await mode.getByText('System', { exact: true }).click()
    await page.keyboard.press('ArrowRight')
    await expect(mode.getByRole('radio', { name: 'Light' })).toBeChecked()
    await page.keyboard.press('ArrowRight')
    await expect(mode.getByRole('radio', { name: 'Dark' })).toBeChecked()
  })

  test('the theme library row opens behind the declared-license contract', async ({ page }) => {
    const panel = await openAppearance(page)
    // An unsaved draft must survive the contract view round-trip.
    await modeGroup(panel).getByText('Dark', { exact: true }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await panel.getByRole('button', { name: 'Manage themes' }).click()

    const library = page.getByRole('dialog', { name: 'Manage themes' })
    await expect(library).toBeVisible()
    await expect(library.getByText('declare an explicit license and provenance')).toBeVisible()
    await expect(library.getByText('signed App Library pipeline')).toBeVisible()

    await library.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(library).toBeHidden()
    // The appearance panel returns with the draft intact and still uncommitted.
    await expect(panel).toBeVisible()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(modeGroup(panel).getByRole('radio', { name: 'Dark' })).toBeChecked()
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
  // The App Library panel is code-split and fetched on first open. A cold dev
  // server transforms that chunk on demand and may re-run the dependency
  // optimizer mid-import, which can outlive the default expect timeout or
  // reload the page and drop the panel state — so retry the open until the
  // panel settles instead of trusting a single click.
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
  const panel = await openAppearance(page)
  await modeGroup(panel).getByText('Dark', { exact: true }).click()
  await panel.getByRole('button', { name: 'Save' }).click()
  const kept = await page.evaluate(() => window.localStorage.getItem('appearance.recovery'))
  expect(JSON.parse(kept!).raw).toBe('{"version":2,"mode":"da')
  expect(
    JSON.parse(await page.evaluate(() => window.localStorage.getItem('appearance')!)).mode
  ).toBe('dark')
})

test('cancel reverts the draft and the OS reduced-motion preference keeps the panel operable', async ({
  page,
}) => {
  // This test lives outside the describe blocks, so it arranges its own page:
  // a pinned preference from another scenario must not leak in, and the
  // workspace must be loaded before the rail can open the panel.
  await page.addInitScript(() => {
    window.localStorage.removeItem('appearance')
    window.localStorage.removeItem('theme')
  })
  await page.goto('/?view=chat')
  await expect(page.getByRole('main')).toBeVisible()

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const panel = await openAppearance(page)

  await modeGroup(panel).getByText('Dark', { exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await panel.getByRole('button', { name: 'Cancel' }).click()
  // Reverting discards the draft; the section stays where it is.
  await expect(panel).toBeVisible()
  // Leaving the draft unsaved restores the pre-open appearance.
  await expect(page.locator('html')).not.toHaveClass(/dark/)

  // Re-open under reduced motion: live previews still apply.
  const reopened = await openAppearance(page)
  await modeGroup(reopened).getByText('Dark', { exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await reopened.getByRole('button', { name: 'Cancel' }).click()
})
