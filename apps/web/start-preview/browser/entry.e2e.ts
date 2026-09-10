import { expect, test } from '@playwright/test'

const workspace = {
  id: 'workspace-start-preview',
  name: 'My Adea',
  scene: 'home',
  updatedAt: '2026-08-25T00:00:00.000Z',
}

test('the real Start host serves a private document and a usable conventional workspace', async ({
  page,
}, testInfo) => {
  const errors: string[] = []
  const scripts: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (request.resourceType() === 'script') scripts.push(request.url())
  })
  await page.route('**/api/workspaces/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: { activeWorkspace: workspace, principal: { temporary: true }, workspaces: [workspace] },
    })
  )
  const response = await page.goto(
    '/?scene=home&view=chat&roomDesigner=0&characterDesigner=0&unknown=retained'
  )
  expect(response?.status()).toBe(200)
  expect(response?.headers()['cache-control']).toBe('private, no-store')
  expect(response?.headers()['x-robots-tag']).toContain('noindex')
  await expect(page.getByRole('button', { name: 'User settings' })).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.workspace-frame--chat')).toBeVisible()
  await expect(page.getByRole('status', { name: 'Virtual view unavailable' })).toHaveCount(0)
  expect(new URL(page.url()).searchParams.get('roomDesigner')).toBe('0')
  expect(new URL(page.url()).searchParams.get('unknown')).toBe('retained')
  expect(scripts.some((url) => new URL(url).pathname.startsWith('/_next/'))).toBe(false)
  expect(scripts.some((url) => /model-viewer|three\.module|agent-sim/.test(url))).toBe(false)
  expect(errors).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('conventional-workspace.png'), fullPage: true })
  await testInfo.attach('script-requests', {
    body: JSON.stringify(scripts, null, 2),
    contentType: 'application/json',
  })
})

test('an unknown path cannot become an unguarded workspace shell', async ({ request }) => {
  const response = await request.get('/not-a-workspace-route')
  expect(response.status()).toBe(404)
  expect(response.headers()['cache-control']).toBe('private, no-store')
})

test('a failed workspace import produces a recoverable route error', async ({ page }) => {
  await page.route('**/start-assets/workspace-navigation-entry-*.js', (route) => route.abort())
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Unable to open Adea' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/')
})
