import { expect, test, type Page } from '@playwright/test'
import axe from 'axe-core'

/**
 * The editor chunk is code-split behind the toolbar trigger, so the first
 * intentional open on a cold dev server (or a cold CI runner) can outlive the
 * default expect timeout — the settings path in appearance.spec.ts guards the
 * same problem. The click is idempotent: the loading fallback and the shared
 * popover carry the same accessible name, and the dialog guard skips the
 * re-open once the editor is up.
 */
async function openLiveAppearance(page: Page) {
  const popup = page.getByRole('dialog', { name: 'Appearance', exact: true })
  await expect(async () => {
    if (await popup.isVisible().catch(() => false)) return
    await page.getByRole('button', { name: 'Appearance settings', exact: true }).click()
    await expect(popup).toBeVisible()
  }).toPass({ timeout: 60_000 })
  return popup
}

for (const width of [1280, 390]) {
  test.describe(`live appearance at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } })

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        if (window.sessionStorage.getItem('appearance-popover-cleaned') === '1') return
        window.localStorage.removeItem('appearance')
        window.localStorage.removeItem('theme')
        window.sessionStorage.setItem('appearance-popover-cleaned', '1')
      })
      await page.goto('/?view=chat&scene=home')
      await expect(page.getByRole('main')).toBeVisible()
    })

    test('font roles default independently, preview, cancel, and survive save and reload', async ({
      page,
    }) => {
      const loadedFontAssets: string[] = []
      page.on('response', (response) => {
        if (response.ok() && /\.woff2?(?:$|[?#])/.test(response.url()))
          loadedFontAssets.push(response.url())
      })
      const popup = await openLiveAppearance(page)
      expect(
        await page.evaluate(
          () =>
            performance
              .getEntriesByType('resource')
              .filter((entry) => /\.woff2?(?:$|[?#])/.test(entry.name)).length
        )
      ).toBe(0)
      for (const [role, size] of [
        ['UI', '14'],
        ['Content', '14'],
        ['Code', '12'],
      ]) {
        await expect(
          popup.getByRole('button', { name: `${role} font family`, exact: true })
        ).toHaveText('System')
        await expect(
          popup.getByRole('spinbutton', { name: `${role} font size in pixels` })
        ).toHaveValue(size!)
      }

      const contentFamily = popup.getByRole('button', { name: 'Content font family', exact: true })
      await contentFamily.click()
      const menu = page.getByRole('menu', { name: 'Content font family', exact: true })
      await expect(menu.getByRole('menuitemradio').first()).toHaveText('System')
      await expect(menu.getByRole('separator')).toHaveCount(1)
      await menu.getByRole('menuitemradio', { name: 'Geist', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-content-font', 'geist')
      expect(await page.locator('html').getAttribute('data-ui-font')).toBeNull()
      const contentSize = popup.getByRole('spinbutton', { name: 'Content font size in pixels' })
      await contentSize.fill('18')
      await contentSize.press('Tab')
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.documentElement.style.getPropertyValue('--font-content-size')
          )
        )
        .toBe('18px')
      await popup.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(popup).toBeHidden()
      expect(await page.locator('html').getAttribute('data-content-font')).toBeNull()
      expect(await page.evaluate(() => localStorage.getItem('appearance'))).toBeNull()

      const reopened = await openLiveAppearance(page)
      const codeFamily = reopened.getByRole('button', { name: 'Code font family', exact: true })
      await codeFamily.click()
      await page
        .getByRole('menu', { name: 'Code font family', exact: true })
        .getByRole('menuitemradio', { name: 'JetBrains Mono', exact: true })
        .click()
      const codeSize = reopened.getByRole('spinbutton', { name: 'Code font size in pixels' })
      await codeSize.fill('16')
      await codeSize.press('Tab')
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...document.fonts].some(
              (face) => face.family.includes('JetBrains Mono') && face.status === 'loaded'
            )
          )
        )
        .toBe(true)
      await expect
        .poll(() => loadedFontAssets.some((url) => url.includes('jetbrains-mono')))
        .toBe(true)
      await reopened.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(reopened).toBeHidden()
      expect(
        await page.evaluate(() => JSON.parse(localStorage.getItem('appearance')!).fonts)
      ).toEqual({
        ui: { family: 'system', size: 14 },
        content: { family: 'system', size: 14 },
        code: { family: 'jetbrains-mono', size: 16 },
      })
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('data-code-font', 'jetbrains-mono')
      await expect
        .poll(() =>
          page.evaluate(() => document.documentElement.style.getPropertyValue('--font-code-size'))
        )
        .toBe('16px')
      const restored = await openLiveAppearance(page)
      await expect(
        restored.getByRole('button', { name: 'Code font family', exact: true })
      ).toHaveText('JetBrains Mono')
      await expect(
        restored.getByRole('spinbutton', { name: 'Code font size in pixels' })
      ).toHaveValue('16')
    })

    test('opens over the current view, previews, saves and restores trigger focus', async ({
      page,
    }) => {
      const trigger = page.getByRole('button', { name: 'Appearance settings', exact: true })
      const before = page.url()
      const popup = await openLiveAppearance(page)
      expect(page.url()).toBe(before)
      await expect(page.getByRole('main', { includeHidden: true })).toBeVisible()
      await popup
        .getByRole('radiogroup', { name: 'Appearance mode' })
        .getByText('Dark', { exact: true })
        .click()
      await popup.getByRole('button', { name: 'Dark theme', exact: true }).click()
      await page.getByRole('menuitemradio', { name: 'Nord', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord')
      await popup.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(popup).toBeHidden()
      await expect(trigger).toBeFocused()
      expect(
        JSON.parse((await page.evaluate(() => localStorage.getItem('appearance')))!).darkThemeId
      ).toBe('nord')
      await trigger.click()
      await expect(popup.getByRole('button', { name: 'Dark theme', exact: true })).toHaveText(
        'Nord'
      )
      await page.keyboard.press('Escape')
      await expect(popup).toBeHidden()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord')
    })

    test('the trigger reads pressed while its sheet is open', async ({ page }) => {
      // The open sheet is modal: it marks the top bar aria-hidden, so the
      // role locator cannot resolve the trigger while pressed. The attribute
      // locator reads the same element in both states.
      const trigger = page.locator('button[aria-label="Appearance settings"]')
      const popup = await openLiveAppearance(page)
      // Kobalte marks the trigger `data-expanded` while the sheet is open; the
      // published pressed rung (the menubar's `data-expanded:bg-surface-active`)
      // has to ride on that state so an open control no longer reads identical
      // to its closed neighbours.
      await expect(trigger).toHaveAttribute('data-expanded', '')
      const surfaceActivePaint = await page.evaluate(() => {
        const probe = document.createElement('div')
        probe.style.backgroundColor = 'var(--surface-active)'
        document.body.append(probe)
        const value = getComputedStyle(probe).backgroundColor
        probe.remove()
        return value
      })
      // The pointer rests on the trigger after opening it, and the shared
      // control's hover rung legitimately paints while it does. Move it away
      // so the sample reads the open (pressed) paint, not the hover paint.
      await page.mouse.move(4, 300)
      // The shared control transitions colours; sample once the paint settles
      // instead of catching the interpolation's first frames.
      await expect
        .poll(() => trigger.evaluate((element) => getComputedStyle(element).backgroundColor))
        .toBe(surfaceActivePaint)

      // Dismiss through the sheet's own close affordance: the dismissed panel
      // must leave the trigger released.
      await popup.getByRole('button', { name: 'Close appearance settings' }).click()
      await expect(popup).toBeHidden()
      await expect
        .poll(() => trigger.evaluate((element) => getComputedStyle(element).backgroundColor))
        .not.toBe(surfaceActivePaint)
    })

    test('Cancel, Escape and outside dismissal revert the opening snapshot', async ({ page }) => {
      const trigger = page.getByRole('button', { name: 'Appearance settings', exact: true })
      const before = await page.locator('html').getAttribute('data-theme')
      for (const dismiss of ['Cancel', 'Escape', 'outside']) {
        const popup = await openLiveAppearance(page)
        await popup
          .getByRole('radiogroup', { name: 'Appearance mode' })
          .getByText('Light', { exact: true })
          .click()
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'adea-light')
        if (dismiss === 'Cancel')
          await popup.getByRole('button', { name: 'Cancel', exact: true }).click()
        else if (dismiss === 'Escape') await page.keyboard.press('Escape')
        else await page.mouse.click(2, 842)
        await expect(popup).toBeHidden()
        await expect(trigger).toBeFocused()
        await expect(page.locator('html')).toHaveAttribute('data-theme', before!)
        expect(await page.evaluate(() => localStorage.getItem('appearance'))).toBeNull()
      }
    })

    test('saving with no edits closes without writing and shows no disabled-state copy', async ({
      page,
    }) => {
      const popup = await openLiveAppearance(page)
      // The sheet keeps Save available on a fresh open: the disabled-state
      // reason line is a settings-section treatment, and a clean save is a
      // dismissal, so there is nothing for the copy to explain.
      await expect(popup.getByText('No changes to save yet.')).toHaveCount(0)
      await popup.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(popup).toBeHidden()
      expect(await page.evaluate(() => localStorage.getItem('appearance'))).toBeNull()
    })

    test('the toolbar trigger tooltip keeps its icon across the lazy trigger swap', async ({
      page,
    }) => {
      // The control swaps its lazy loading fallback for the popover's own
      // persistent trigger after the first open. Both generations run through
      // the shared ActionButton and must repeat the trigger glyph in the tip's
      // icon cell, like every other top-bar icon action.
      const trigger = page.getByRole('button', { name: 'Appearance settings', exact: true })
      const expectIconTip = async () => {
        // A cold dev server hydrates long after the SSR shell paints; the
        // hover-and-tip exchange retries through that window like
        // openLiveAppearance does for the dialog. Each attempt leaves the
        // control first: a hover already on the trigger dispatches no new
        // pointerenter, and after a sheet close the restored focus needs the
        // pointer to move off the control (releasing the focus gate's phantom)
        // before a real hover can open the tip.
        await expect(async () => {
          await page.mouse.move(2, 400)
          await trigger.hover()
          const tooltip = page.getByRole('tooltip')
          await expect(tooltip).toHaveText('Open appearance settings')
          const icon = tooltip.locator('[data-slot="tooltip-icon"]')
          await expect(icon).toHaveCount(1)
          await expect(icon.locator('svg')).toHaveCount(1)
        }).toPass({ timeout: 60_000 })
        await page.mouse.move(2, 400)
        await expect(page.getByRole('tooltip')).toBeHidden()
      }
      // Before the first open the control is the loading fallback.
      await expectIconTip()
      const popup = await openLiveAppearance(page)
      await popup.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(popup).toBeHidden()
      // After the swap the trigger is the popover composition's own
      // SheetTrigger — the surface that lost the icon when the editor fork
      // recomposed the control.
      await expect(trigger).toBeFocused()
      await expectIconTip()
    })

    test('the nested theme library retains the preview and returns focus', async ({ page }) => {
      const popup = await openLiveAppearance(page)
      await popup
        .getByRole('radiogroup', { name: 'Appearance mode' })
        .getByText('Light', { exact: true })
        .click()
      const manage = popup.getByRole('button', { name: 'Manage themes', exact: true })
      await manage.click()
      const library = page.getByRole('dialog', { name: 'Manage themes', exact: true })
      await expect(library).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(library).toBeHidden()
      await expect(popup).toBeVisible()
      await expect(manage).toBeFocused()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'adea-light')
      await popup.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(popup).toBeHidden()
    })

    test('keeps actions reachable with 200% text enlargement and passes automated accessibility', async ({
      page,
    }) => {
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%'
      })
      const popup = await openLiveAppearance(page)
      // The popover opens with an entrance transform: a bounding box read
      // mid-animation can overshoot the viewport, so poll until the frame
      // settles instead of trusting a single sample. Linux font metrics run
      // taller than the darwin baselines, so the editor legitimately scrolls
      // at 200% text — the accessible contract is that the frame stays inside
      // the viewport and the actions become reachable through its own scroll.
      await expect(async () => {
        const bounds = await popup.boundingBox()
        expect(bounds).not.toBeNull()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
      }).toPass({ timeout: 15_000 })
      const save = popup.getByRole('button', { name: 'Save', exact: true })
      const cancel = popup.getByRole('button', { name: 'Cancel', exact: true })
      await save.scrollIntoViewIfNeeded()
      await expect(save).toBeInViewport()
      await cancel.scrollIntoViewIfNeeded()
      await expect(cancel).toBeInViewport()
      await page.addScriptTag({ content: axe.source })
      const result = await page.evaluate(async () => {
        const audit = window as unknown as {
          axe: {
            run: (
              context: Document,
              options: object
            ) => Promise<{
              violations: { id: string; impact: string; nodes: { target: string[] }[] }[]
            }>
          }
        }
        return audit.axe.run(document, {
          runOnly: {
            type: 'tag',
            values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
          },
        })
      })
      expect(
        result.violations.map(({ id, impact, nodes }) => ({
          id,
          impact,
          targets: nodes.map(({ target }) => target),
        }))
      ).toEqual([])
    })
  })
}
