import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

async function openFixture(page: Page) {
  const path = '/__workspace-accent'
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
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-appearance-harness-app.tsx')
  )
  await page.getByRole('button', { name: 'Appearance settings', exact: true }).click()
  return page.getByRole('dialog', { name: 'Appearance', exact: true })
}

for (const width of [360, 1280]) {
  test(`presets form one equally spaced row with Custom on the right at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const popup = await openFixture(page)
    const row = popup.locator('[data-accent-choices]')
    await row.scrollIntoViewIfNeeded()
    await expect
      .poll(() =>
        popup.evaluate((element) =>
          element
            .getAnimations({ subtree: true })
            .some((animation) => animation.playState === 'running')
        )
      )
      .toBe(false)
    const swatches = row.locator('svg.size-full')
    await expect(swatches).toHaveCount(6)
    const boxes = await swatches.evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect()
        return { x: r.x, y: r.y, right: r.right }
      })
    )
    expect(Math.max(...boxes.map((b) => b.y)) - Math.min(...boxes.map((b) => b.y))).toBeLessThan(1)
    const steps = boxes.slice(1).map((b, i) => b.x - boxes[i]!.x)
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(1)
    const custom = await row.getByRole('button', { name: 'Custom', exact: true }).boundingBox()
    expect(custom!.x).toBeGreaterThan(boxes[5]!.right)
    expect(custom!.x + custom!.width).toBeLessThanOrEqual(width)
    await popup.screenshot({ path: `../evidence/accent-row-${width}.png` })
  })
}

test('Custom opens the color selector without changing the draft; chosen color saves and Cancel restores it', async ({
  page,
}) => {
  const popup = await openFixture(page)
  const saved = await page.evaluate(() => localStorage.getItem('appearance'))
  await page.evaluate(() => {
    const nativeShowPicker = HTMLInputElement.prototype.showPicker
    HTMLInputElement.prototype.showPicker = function () {
      nativeShowPicker.call(this)
      this.dataset.pickerOpened = 'true'
    }
  })
  await popup.getByRole('button', { name: 'Custom', exact: true }).click()
  const picker = popup.locator('input[type="color"]')
  await expect(picker).toHaveAttribute('data-picker-opened', 'true')
  expect(await page.evaluate(() => localStorage.getItem('appearance'))).toBe(saved)
  await expect(popup.getByRole('textbox', { name: 'Custom accent', exact: true })).toHaveCount(0)
  await picker.fill('#2563eb')
  const hex = popup.getByRole('textbox', { name: 'Custom accent', exact: true })
  await expect(hex).toBeVisible()
  await hex.fill('invalid')
  await hex.blur()
  await expect(popup.getByText('“invalid” is not a hex color such as #2563eb.')).toBeVisible()
  await hex.fill('#2563eb')
  await hex.blur()
  await popup.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(popup).not.toBeVisible()
  const committed = await page.evaluate(() => localStorage.getItem('appearance'))
  expect(JSON.parse(committed!).accent).toBe('#2563eb')
  await page.getByRole('button', { name: 'Appearance settings', exact: true }).click()
  await expect(hex).toHaveValue('#2563eb')
  await popup.getByRole('radio', { name: 'Pink', exact: true }).press('Space')
  await popup.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await page.evaluate(() => localStorage.getItem('appearance'))).toBe(committed)
  await page.getByRole('button', { name: 'Appearance settings', exact: true }).click()
  await expect(hex).toHaveValue('#2563eb')
})
