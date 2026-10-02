import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * The appearance editor lives in the settings dialog's Appearance section (the
 * toolbar also offers a live popover, #425/#757). This preserves the settings path a
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
      // Bounded on purpose: a reload after Save keeps the settings hash, and
      // the app re-opens the dialog from it ~600ms into the mount, closing the
      // account menu mid-sequence. An unbounded click would hang until the
      // toPass budget runs out; a bounded one throws and the next iteration
      // finds the restored dialog instead.
      await page.getByRole('button', { name: 'User settings' }).click({ timeout: 5_000 })
      await page.getByRole('menuitem', { name: 'Settings' }).click({ timeout: 5_000 })
    }
    await settings.getByRole('tab', { name: 'Appearance' }).click({ timeout: 5_000 })
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

/** The pinned terminal palette as an INLINE property: the stylesheet always
 * resolves a computed value, so only the inline map proves a pin exists. */
function inlineTerminalBackground(page: Page) {
  return page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--terminal-background').trim()
  )
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
    await page.getByRole('menuitemradio', { name: 'Nord', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord')
    await expect(editor(panel).getByRole('button', { name: 'Dark theme', exact: true })).toHaveText(
      'Nord'
    )

    await panel.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord')

    // The saved preference survives a reload through the pre-paint script.
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord')
    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  test('the theme rows offer the published catalogue, and a catalogue theme applies', async ({
    page,
  }) => {
    const panel = await openAppearance(page)

    await modeGroup(panel).getByText('Dark', { exact: true }).click()
    await editor(panel).getByText('Adea Dark', { exact: true }).click()

    // The rows are the whole included catalogue, not just the Adea families.
    await expect(page.getByRole('menuitemradio', { name: 'Catppuccin Mocha' })).toBeVisible()
    await expect(
      page.getByRole('menuitemradio', { name: 'Tokyo Night', exact: true })
    ).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: 'Rosé Pine Moon' })).toBeVisible()

    // Selecting one re-skins the live document from the generated data-theme
    // tokens, and the editor's own preview follows it.
    await page.getByRole('menuitemradio', { name: 'Catppuccin Mocha' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'catppuccin-mocha')
    await expect(editor(panel).getByRole('button', { name: 'Dark theme', exact: true })).toHaveText(
      'Catppuccin Mocha'
    )

    await panel.getByRole('button', { name: 'Save' }).click()
    await page.reload()
    // The pre-paint script resolves the stored catalogue id and the generated
    // stylesheet paints it before hydration.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'catppuccin-mocha')
  })

  test('the terminal row pins a palette separate from the interface theme', async ({ page }) => {
    const panel = await openAppearance(page)
    await modeGroup(panel).getByText('Dark', { exact: true }).click()
    const terminal = editor(panel).getByRole('button', { name: 'Terminal', exact: true })

    // Default: the terminal follows the interface theme, so no inline
    // --terminal-* override exists on the root.
    await expect(terminal).toHaveText('UI theme')
    expect(await inlineTerminalBackground(page)).toBe('')

    // The row offers UI theme plus the full catalogue behind its own menu.
    await terminal.click()
    await expect(page.getByRole('menuitemradio', { name: 'UI theme', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: 'Nord', exact: true })).toBeVisible()
    await expect(page.locator('[data-theme-menu-preview]').first()).toBeVisible()
    await page.getByRole('menuitemradio', { name: 'Nord', exact: true }).click()
    await expect(terminal).toHaveText('Nord')
    // Nord's palette lands inline and overrides the interface theme's own
    // terminal roles (adea-dark declares them in the stylesheet).
    expect((await inlineTerminalBackground(page)).toLowerCase()).toBe('#2e3440')

    await panel.getByRole('button', { name: 'Save' }).click()
    await page.reload()
    // The pin survives the reload through the mounted provider; the pre-paint
    // script skips terminal paint on purpose (no terminal exists pre-mount).
    const reloaded = editor(await openAppearance(page)).getByRole('button', {
      name: 'Terminal',
      exact: true,
    })
    await expect(reloaded).toHaveText('Nord')
    await expect.poll(() => inlineTerminalBackground(page)).toBe('#2e3440')

    // Dropping the pin hands the token names back to the interface theme.
    await reloaded.click()
    await page.getByRole('menuitemradio', { name: 'UI theme', exact: true }).click()
    await expect(reloaded).toHaveText('UI theme')
    await expect.poll(() => inlineTerminalBackground(page)).toBe('')
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
    await expect(
      editor(panel).getByText('“not-a-color” is not a hex color such as #2563eb.')
    ).toBeVisible()

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
    await expect(
      panel.getByText('Prefer solid surfaces, including during live preview.')
    ).toBeVisible()
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

  for (const dismiss of ['Close', 'Escape'] as const) {
    test(`the theme library preserves the preview and restores focus after ${dismiss}`, async ({
      page,
    }) => {
      const panel = await openAppearance(page)
      // An unsaved draft and the live editor must survive the nested dialog.
      await modeGroup(panel).getByText('Dark', { exact: true }).click()
      await expect(page.locator('html')).toHaveClass(/dark/)
      const editorElement = await panel.elementHandle()
      const manage = panel.getByRole('button', { name: 'Manage themes' })
      await manage.click()

      const library = page.getByRole('dialog', { name: 'Manage themes' })
      await expect(library).toBeVisible()
      await expect(
        library.getByText('Imported themes appear in the Light and Dark theme menus')
      ).toBeVisible()
      await expect(library.getByText('Import a theme file (.json)')).toBeVisible()
      expect(await editorElement!.evaluate((element) => element.isConnected)).toBe(true)
      // Entrance transforms temporarily establish a containing block. Check
      // the final layout so the corner control cannot drift to the viewport.
      await library.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished))
      })
      expect(
        await library.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          const close = element.querySelector('button[aria-label="Close"]')?.getBoundingClientRect()
          return (
            close !== undefined &&
            close.left >= bounds.left &&
            close.top >= bounds.top &&
            close.right <= bounds.right &&
            close.bottom <= bounds.bottom
          )
        })
      ).toBe(true)

      if (dismiss === 'Escape') await page.keyboard.press('Escape')
      else
        await library.locator('footer').getByRole('button', { name: 'Close', exact: true }).click()
      await expect(library).toBeHidden()
      await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible()
      await expect(manage).toBeFocused()
      await expect(panel).toBeVisible()
      await expect(page.locator('html')).toHaveClass(/dark/)
      await expect(modeGroup(panel).getByRole('radio', { name: 'Dark' })).toBeChecked()
      expect(await page.evaluate(() => window.localStorage.getItem('appearance'))).toBeNull()
      await editorElement!.dispose()
    })
  }

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

test.describe('App Library navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('adea:library-scenario') === '1') return
      localStorage.removeItem('adea:rail-preferences:v1')
      sessionStorage.setItem('adea:library-scenario', '1')
    })
    await page.goto('/?view=chat')
  })

  test('disabled views remain recoverable through the separate Library', async ({ page }) => {
    const rail = page.getByRole('navigation', { name: 'Global navigation' })
    await rail.getByRole('button', { name: 'App Library', exact: true }).click()
    const library = page.getByRole('main', { name: 'App Library' })
    await library.getByRole('button', { name: 'Disable Dev', exact: true }).click()
    await expect(rail.getByRole('button', { name: 'Dev view', exact: true })).toHaveCount(0)
    await page.reload()
    await expect(library.getByRole('button', { name: 'Enable Dev', exact: true })).toBeVisible()
    await library.getByRole('button', { name: 'Enable Dev', exact: true }).click()
    await expect(rail.getByRole('button', { name: 'Dev view', exact: true })).toBeVisible()
  })

  test('a disabled requested view selects an enabled destination', async ({ page }) => {
    const rail = page.getByRole('navigation', { name: 'Global navigation' })
    await rail.getByRole('button', { name: 'App Library', exact: true }).click()
    const library = page.getByRole('main', { name: 'App Library' })
    await library.getByRole('button', { name: 'Disable Chat', exact: true }).click()
    await page.goto('/?view=chat')
    await expect(rail.getByRole('button', { name: 'Chat view', exact: true })).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible()
    await rail.getByRole('button', { name: 'App Library', exact: true }).click()
    await library.getByRole('button', { name: 'Enable Chat', exact: true }).click()
    await library.getByRole('button', { name: 'Open Chat', exact: true }).click()
    await expect(rail.getByRole('button', { name: 'Chat view', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
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

// Contrast IDs remain supported persisted preferences alongside the rest of
// the published catalogue the picker now offers.
for (const [selectedMode, themeId] of [
  ['light', 'adea-light'],
  ['light', 'nord-light'],
  ['light', 'adea-light-high-contrast'],
  ['dark', 'adea-dark'],
  ['dark', 'nord'],
  ['dark', 'adea-dark-high-contrast'],
] as const) {
  test(`published destructive actions retain normal and hover contrast for persisted ${themeId}`, async ({
    page,
  }) => {
    await page.addInitScript(
      ({ mode, id }) => {
        window.localStorage.setItem(
          'appearance',
          JSON.stringify({
            version: 2,
            mode,
            lightThemeId: mode === 'light' ? id : 'adea-light',
            darkThemeId: mode === 'dark' ? id : 'adea-dark',
            accent: 'theme',
            surface: 'opaque',
            reduceTransparency: false,
          })
        )
      },
      { mode: selectedMode, id: themeId }
    )
    await page.goto('/?view=chat')
    await expect(page.locator('html')).toHaveAttribute('data-theme', themeId)
    const panel = await openAppearance(page)
    const entry = resolve(process.cwd(), 'apps/web/e2e/helpers/destructive-action-probe.tsx')
    await page.addScriptTag({ type: 'module', content: `import '${'/@fs' + entry}'` })
    const button = page.getByRole('button', { name: 'Destructive action probe', exact: true })
    for (const hover of [false, true]) {
      if (hover) await button.hover()
      else await panel.getByRole('heading', { name: 'Appearance', exact: true }).hover()
      await expect
        .poll(
          () =>
            button.evaluate((element) => {
              const style = getComputedStyle(element)
              // Canvas normalizes CSS Color 4 (including hover color-mix)
              // into rendered sRGB channels before the WCAG calculation.
              const context = document.createElement('canvas').getContext('2d')!
              const renderedChannels = (color: string) => {
                context.clearRect(0, 0, 1, 1)
                context.fillStyle = color
                context.fillRect(0, 0, 1, 1)
                const values = Array.from(context.getImageData(0, 0, 1, 1).data)
                return [...values.slice(0, 3), values[3]! / 255]
              }
              const foreground = renderedChannels(style.color)
              const background = renderedChannels(style.backgroundColor)
              const canvas = renderedChannels(
                getComputedStyle(element.parentElement!).backgroundColor
              )
              const alpha = background[3] ?? 1
              const opaque = background
                .slice(0, 3)
                .map((value, index) => value * alpha + canvas[index]! * (1 - alpha))
              // This function runs in the browser realm, so it must stay inside evaluate.
              // oxlint-disable-next-line unicorn/consistent-function-scoping
              const luminance = (channels: number[]) =>
                channels
                  .map((value) => {
                    const channel = value / 255
                    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
                  })
                  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0)
              const front = luminance(foreground.slice(0, 3)),
                back = luminance(opaque)
              return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05)
            }),
          { message: `${themeId} ${hover ? 'hover' : 'normal'} action contrast` }
        )
        .toBeGreaterThanOrEqual(4.5)
    }
  })
}
