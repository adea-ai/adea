import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

async function mount(page: import('@playwright/test').Page) {
  const path = '/__desktop-runtime-chat'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><head><style>html,body,#harness-root{margin:0;height:100%;}</style></head><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  const entry = resolve(process.cwd(), 'apps/web/e2e/helpers/desktop-runtime-chat-harness-app.tsx')
  await page.addScriptTag({ type: 'module', content: `import '${'/@fs' + entry}'` })
  await expect(page.getByRole('heading', { name: 'First canonical session' })).toBeVisible()
}

test('Dev sidebar search reveals matching hierarchy and restores collapse state', async ({
  page,
}) => {
  await mount(page)

  const sidebar = page.getByRole('complementary', { name: 'Projects and sessions' })
  const group = sidebar.getByRole('button', { name: 'Runtime group' })
  const project = sidebar.getByRole('button', { name: /Canonical project/ })
  const sessions = sidebar.locator('.dev-tree-row--session')
  const filter = page.getByRole('searchbox', { name: 'Filter projects and sessions' })

  await expect(group).toHaveAttribute('aria-expanded', 'true')
  await expect(project).toHaveAttribute('aria-expanded', 'true')
  await project.click()
  await expect(project).toHaveAttribute('aria-expanded', 'false')
  await page.evaluate(() => window.desktopRuntimeChatHarness.selectFirst())
  await expect(page.getByRole('heading', { name: 'First canonical session' })).toBeVisible()
  await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(project).toHaveCount(0)

  const before = await page.evaluate(() => window.desktopRuntimeChatHarness.report())

  await filter.fill('runtime group')
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  await expect(project).toHaveAttribute('aria-expanded', 'true')
  await expect(sessions).toHaveCount(2)

  await filter.fill('canonical project')
  await expect(project).toHaveCount(1)
  await expect(sessions).toHaveCount(2)

  await filter.fill('Second canonical session')
  await expect(sessions).toHaveCount(1)
  await expect(sessions).toContainText('Second canonical session')

  await filter.fill('no matching row')
  await expect(sidebar.getByText('No matching projects or sessions.')).toBeVisible()

  await filter.clear()
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(project).toHaveCount(0)
  await group.click()
  await expect(project).toHaveAttribute('aria-expanded', 'false')
  await expect(sessions).toHaveCount(0)

  const after = await page.evaluate(() => window.desktopRuntimeChatHarness.report())
  expect(after.selected).toBe(before.selected)
  expect(after.calls).toEqual(before.calls)
})
