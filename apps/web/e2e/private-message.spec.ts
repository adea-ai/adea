import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test.use({ headless: true })

for (const surface of ['message', 'objective']) {
  test.describe(surface, () => {
    test.beforeEach(async ({ page }) => {
      const path = '/__private-message?surface=' + surface
      await page.route('**' + path, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<html><body><div id="harness-root"></div></body></html>',
        })
      )
      await page.goto(path)
      await page.evaluate(
        async (url) => {
          await import(url)
        },
        '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/private-message-harness-app.tsx')
      )
      await expect(
        page.getByText(
          surface === 'objective' ? 'Opening private objective…' : 'Opening private content…'
        )
      ).toBeVisible()
    })

    test('late private body cannot replace the current message', async ({ page }) => {
      const currentContent =
        surface === 'objective' ? 'Current private objective' : 'Current private body'
      await page.getByRole('button', { name: 'Switch message' }).click()
      await expect(page.locator('[data-message-id="second"]')).toBeVisible()
      await page.getByRole('button', { name: 'Resolve current' }).click()
      await expect(page.getByText(currentContent)).toBeVisible()
      await page.getByRole('button', { name: 'Resolve old', exact: true }).click()
      await expect(page.getByText(currentContent)).toBeVisible()
      await expect(
        page.getByText(surface === 'objective' ? 'Old private objective' : 'Old private body')
      ).toHaveCount(0)
    })

    test('late failure cannot mark the current request unavailable', async ({ page }) => {
      const currentContent =
        surface === 'objective' ? 'Current private objective' : 'Current private body'
      await page.getByRole('button', { name: 'Switch message' }).click()
      await expect(page.locator('[data-message-id="second"]')).toBeVisible()
      await page.getByRole('button', { name: 'Reject old' }).click()
      await expect(
        page.getByText(
          surface === 'objective' ? 'Opening private objective…' : 'Opening private content…'
        )
      ).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
      await page.getByRole('button', { name: 'Resolve current' }).click()
      await expect(page.getByText(currentContent)).toBeVisible()
    })

    test('resolved private content is hidden when the item changes', async ({ page }) => {
      const oldContent = surface === 'objective' ? 'Old private objective' : 'Old private body'
      await page.getByRole('button', { name: 'Resolve old', exact: true }).click()
      await expect(page.getByText(oldContent)).toBeVisible()
      await page.getByRole('button', { name: 'Switch message' }).click()
      await expect(page.getByTestId('switch-observation')).toHaveText('clear')
      await expect(page.getByText(oldContent)).toHaveCount(0)
      await expect(
        page.getByText(
          surface === 'objective' ? 'Opening private objective…' : 'Opening private content…'
        )
      ).toBeVisible()
    })
  })
}
