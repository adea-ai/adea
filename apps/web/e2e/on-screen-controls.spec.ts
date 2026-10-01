import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('releases a held movement key when on-screen controls unmount', async ({ page }) => {
  const path = '/__on-screen-controls'
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
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/on-screen-controls-harness-app.tsx')
  )

  const moveForward = page.getByRole('button', { name: 'Move forward', exact: true })
  const keyEvents = page.getByTestId('key-events')
  await expect(moveForward).toBeVisible()
  await moveForward.hover()
  await page.mouse.down()
  await expect(keyEvents).toHaveText('keydown:KeyW')

  await page.evaluate(() => window.dispatchEvent(new Event('unmount-on-screen-controls')))
  await expect(moveForward).toHaveCount(0)
  await expect(keyEvents).toHaveText('keydown:KeyW|keyup:KeyW')

  await page.mouse.up()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(keyEvents).toHaveText('keydown:KeyW|keyup:KeyW')
})
