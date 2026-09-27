import { expect, test } from '@playwright/test'

// Mount the actual web route. Packaged desktop entry/recovery is checked by
// scripts/check-desktop-client-browser.mjs against the canonical desktop build.
test('web navigation does not request the native workspace entry', async ({ page }) => {
  const nativeRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/desktop-workspace-entry.tsx')) nativeRequests.push(request.url())
  })
  await page.goto('/?view=chat')
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'User settings' })).toBeVisible()
  expect(nativeRequests).toEqual([])
})
