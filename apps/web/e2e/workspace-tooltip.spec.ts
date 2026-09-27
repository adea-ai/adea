import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('production status tooltip uses shared content without intercepting pointer actions', async ({
  page,
}) => {
  const path = '/__workspace-tooltip'
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
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-tooltip-harness-app.tsx')
  )
  await page.getByText('Configured', { exact: true }).hover()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toHaveText('Persisted Agent lifecycle and AgentProfile configuration')
  await expect(tooltip.locator('svg')).toHaveCount(0)
  expect(await tooltip.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe('none')
  expect(
    await tooltip.evaluate((node) => getComputedStyle(node.parentElement!).pointerEvents)
  ).toBe('none')
  await page.getByRole('button', { name: 'Next action', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Next action', exact: true })).toBeFocused()
  await expect(tooltip).toBeHidden()
})
