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

test('an ActionButton tooltipIcon repeats the trigger glyph like the raw tooltip', async ({
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
  // The top bar's icon actions run through ActionButton, so its tooltipIcon
  // passthrough must reach the same decorative icon cell the raw tooltip uses.
  await page
    .getByRole('region', { name: 'Icon action button' })
    .getByRole('button', { name: 'Notifications' })
    .hover()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toHaveText('Notifications are not available yet.')
  const icon = tooltip.locator('[data-slot="tooltip-icon"]')
  await expect(icon).toHaveCount(1)
  await expect(icon.locator('svg')).toHaveCount(1)
  await expect(icon).toHaveAttribute('aria-hidden', 'true')
  expect(await tooltip.evaluate((node) => getComputedStyle(node).display)).toBe('flex')
  expect(await tooltip.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('nowrap')
})

test('autofocus from a sheet never opens the tooltip, a real hover still does', async ({
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
  await page.getByRole('button', { name: 'Open runtime sheet mock' }).click()
  const refresh = page.getByRole('button', { name: 'Refresh resources' })
  await expect(refresh).toBeFocused()
  // The defect under repair: the sheet's autofocus popped the refresh
  // tooltip instantly and it stayed pinned while the pointer was elsewhere.
  // The tooltip must never open from programmatic focus at all.
  await page.waitForTimeout(600)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await expect(refresh).not.toHaveAttribute('aria-describedby')
  // A real hover opens, and moving the pointer away closes.
  await refresh.hover()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toHaveText('Refresh runtime resources')
  await page.getByRole('button', { name: 'Next action', exact: true }).hover()
  await expect(tooltip).toBeHidden()
})

test('keyboard focus still announces the control tooltip', async ({ page }) => {
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
  // Tab navigation moves focus with keyboard intent, so the tooltip stays
  // reachable from the keyboard exactly as it was before the gate.
  await page.getByRole('button', { name: 'Next action', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Next action', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('tooltip')).toHaveText('Search this conversation (Mod+F)')
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
