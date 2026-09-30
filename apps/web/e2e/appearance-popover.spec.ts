import { expect, test } from '@playwright/test'
import axe from 'axe-core'

for (const width of [1280, 390]) {
  test.describe(`live appearance at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } })

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        window.localStorage.removeItem('appearance')
        window.localStorage.removeItem('theme')
      })
      await page.goto('/?view=chat&scene=home')
      await expect(page.getByRole('main')).toBeVisible()
    })

    test('opens over the current view, previews, saves and restores trigger focus', async ({
      page,
    }) => {
      const trigger = page.getByRole('button', { name: 'Appearance settings', exact: true })
      const before = page.url()
      await trigger.click()
      const popup = page.getByRole('dialog', { name: 'Appearance', exact: true })
      await expect(popup).toBeVisible()
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
        await trigger.click()
        const popup = page.getByRole('dialog', { name: 'Appearance', exact: true })
        await expect(popup).toBeVisible()
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
      await page.getByRole('button', { name: 'Appearance settings', exact: true }).click()
      const popup = page.getByRole('dialog', { name: 'Appearance', exact: true })
      await expect(popup).toBeVisible()
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
      await page.getByRole('button', { name: 'Appearance settings', exact: true }).click()
      const popup = page.getByRole('dialog', { name: 'Appearance', exact: true })
      await expect(popup).toBeVisible()
      const bounds = await popup.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
      await expect(popup.getByRole('button', { name: 'Save', exact: true })).toBeInViewport()
      await expect(popup.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport()
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
