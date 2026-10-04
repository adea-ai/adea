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
