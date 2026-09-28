import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('workspace loading renders six visible placeholders and honours reduced motion', async ({
  page,
}) => {
  const path = '/__workspace-loading'
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
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-loading-harness-app.tsx')
  )
  const loading = page.getByLabel('Loading messages', { exact: true })
  await expect(loading).toHaveAttribute('aria-busy', 'true')
  const bars = loading.locator(':scope > *')
  await expect(bars).toHaveCount(6)
  for (const bar of await bars.all()) {
    const box = await bar.boundingBox()
    expect(box?.height).toBeGreaterThan(8)
    expect(box?.width).toBeGreaterThan(80)
    await expect(bar).toHaveAttribute('aria-hidden', 'true')
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const bar of await bars.all()) {
    await expect(bar).toHaveCSS('animation-duration', '1e-05s')
    await expect(bar).toHaveCSS('animation-iteration-count', '1')
  }
})
