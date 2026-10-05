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
  await page
    .getByRole('region', { name: 'Status badge' })
    .getByText('Configured', { exact: true })
    .hover()
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

test('an icon tooltip repeats the trigger glyph in a single icon+label row', async ({ page }) => {
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
  await page
    .getByRole('region', { name: 'Icon action' })
    .getByRole('button', { name: 'Search this conversation' })
    .hover()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toHaveText('Search this conversation (Mod+F)')
  // The icon slot renders the trigger's glyph as a leading decorative cell; the
  // accessible name stays on the trigger, never in the tip.
  const icon = tooltip.locator('[data-slot="tooltip-icon"]')
  await expect(icon).toHaveCount(1)
  await expect(icon.locator('svg')).toHaveCount(1)
  await expect(icon).toHaveAttribute('aria-hidden', 'true')
  // One row that reads as a unit: icon and label on a single line.
  expect(await tooltip.evaluate((node) => getComputedStyle(node).display)).toBe('flex')
  expect(await tooltip.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('nowrap')
})

test('agent status follows profile and lifecycle updates without remounting', async ({ page }) => {
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
  for (const name of ['Status badge', 'Status details']) {
    await expect(
      page.getByRole('region', { name }).getByText('Configured', { exact: true })
    ).toBeVisible()
  }
  await page.getByRole('button', { name: 'Invalidate profile', exact: true }).click()
  for (const name of ['Status badge', 'Status details']) {
    await expect(
      page.getByRole('region', { name }).getByText('Needs configuration', { exact: true })
    ).toBeVisible()
  }
  await page.getByRole('button', { name: 'Archive agent', exact: true }).click()
  for (const name of ['Status badge', 'Status details']) {
    await expect(
      page.getByRole('region', { name }).getByText('Archived', { exact: true })
    ).toBeVisible()
  }
  await page.getByRole('button', { name: 'Restore agent', exact: true }).click()
  for (const name of ['Status badge', 'Status details']) {
    await expect(
      page.getByRole('region', { name }).getByText('Configured', { exact: true })
    ).toBeVisible()
  }
  await expect(page.getByText('Runtime unknown', { exact: true })).toBeVisible()
  await expect(page.getByText('Activity unknown', { exact: true })).toBeVisible()
})
