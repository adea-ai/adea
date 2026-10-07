import { expect, test } from '@playwright/test'

import {
  BROWSER_PANE_HARNESS_PATH,
  browserPaneHarnessHtml,
  browserPaneHarnessModuleSource,
} from './helpers/dev-browser-pane-harness'

test.use({ headless: true })

async function mountResourcesPane(page: import('@playwright/test').Page, query = '') {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('**' + BROWSER_PANE_HARNESS_PATH + '**', (route) =>
    route.fulfill({ contentType: 'text/html', body: browserPaneHarnessHtml() })
  )
  await page.goto(`${BROWSER_PANE_HARNESS_PATH}?pane=resources${query}`)
  await page.addScriptTag({ type: 'module', content: browserPaneHarnessModuleSource() })
  const pane = page.getByRole('region', { name: 'Runtime resources' })
  await expect(pane).toBeVisible()
  return pane
}

test.describe('resources sheet structure', () => {
  test('the title band and the clean-up footer pin the scrolling body', async ({ page }) => {
    await mountResourcesPane(page)
    const dialog = page.locator('[role="dialog"][data-variant]')
    const header = dialog.locator('[data-slot="sheet-header"]')
    const body = dialog.locator('[data-slot="sheet-body"]')
    const footer = dialog.locator('[data-slot="sheet-footer"]')

    // The published sheet parts carry the two-toned bands (#1082): the title
    // band holds the title and the refresh/settings actions; the action band
    // holds the clean-up decision.
    await expect(header).toBeVisible()
    await expect(header.locator('.dev-resources__title')).toHaveText('Runtime resources')
    await expect(header.getByRole('button', { name: 'Refresh resources' })).toBeVisible()
    await expect(body).toBeVisible()
    await expect(footer).toBeVisible()
    await expect(footer.getByRole('button', { name: 'Clean up' })).toBeVisible()

    // Pinned anatomy: the region scrolls inside the body and both bands are
    // its siblings, so nothing scrolls them away.
    const structure = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"][data-variant]')
      const headerBand = panel?.querySelector(':scope > [data-slot="sheet-header"]')
      const scrollBody = panel?.querySelector(':scope > [data-slot="sheet-body"]')
      const footerBand = panel?.querySelector(':scope > [data-slot="sheet-footer"]')
      const region = document.querySelector('[role="region"][aria-label="Runtime resources"]')
      return Boolean(
        headerBand && scrollBody && footerBand && region && scrollBody.contains(region)
      )
    })
    expect(structure).toBe(true)

    // The body is the scroll container between the bands.
    expect(await body.evaluate((node) => getComputedStyle(node).overflowY)).toBe('auto')
  })

  test('sections over eight rows collapse with Show more and Show less', async ({ page }) => {
    await mountResourcesPane(page, '&resources=many-foreign')
    const section = page
      .getByRole('region', { name: 'Runtime resources' })
      .locator('section[aria-label="Elsewhere on this machine"]')

    // Collapsed: the first 8 rows plus the control naming the remainder.
    const rows = section.locator('.dev-resources__server')
    await expect(rows).toHaveCount(8)
    const more = section.getByRole('button', { name: 'Show 4 more' })
    await expect(more).toBeVisible()

    // Expanded: every row, and a Show less that restores the window.
    await more.click()
    await expect(rows).toHaveCount(12)
    const less = section.getByRole('button', { name: 'Show less' })
    await expect(less).toBeVisible()
    await less.click()
    await expect(rows).toHaveCount(8)
    await expect(section.getByRole('button', { name: 'Show 4 more' })).toBeVisible()
  })

  test('sections at or under eight rows never show a show-more control', async ({ page }) => {
    await mountResourcesPane(page)
    const region = page.getByRole('region', { name: 'Runtime resources' })
    await expect(region.locator('section[aria-label="Elsewhere on this machine"]')).toHaveCount(0)
    await expect(region.getByRole('button', { name: /Show \d+ more/ })).toHaveCount(0)
  })
})

test.describe('machine-wide janitor', () => {
  test('the janitor tab discovers junk, sizes it async, and collapses big sections', async ({
    page,
  }) => {
    const region = await mountResourcesPane(page, '&janitor=fixture')
    await region.getByRole('tab', { name: 'Junk & leftovers' }).click()

    // Sections in display order; the ten-entry Caches section collapses to 8.
    const derived = region.locator('section[aria-label="Xcode Derived Data"]')
    await expect(derived.getByText('MyApp-abc123', { exact: true })).toBeVisible()
    await expect(derived.getByText('50 MB').first()).toBeVisible()
    const caches = region.locator('section[aria-label="Caches"]')
    await expect(caches.locator('.dev-resources__check-row')).toHaveCount(8)
    await expect(caches.getByRole('button', { name: 'Show 2 more' })).toBeVisible()
    await caches.getByRole('button', { name: 'Show 2 more' }).click()
    await expect(caches.locator('.dev-resources__check-row')).toHaveCount(10)
    await expect(caches.getByRole('button', { name: 'Show less' })).toBeVisible()
  })

  test('cleanup is an explicit plan confirmation naming what goes and the total', async ({
    page,
  }) => {
    const region = await mountResourcesPane(page, '&janitor=fixture')
    await region.getByRole('tab', { name: 'Junk & leftovers' }).click()
    const derived = region.locator('section[aria-label="Xcode Derived Data"]')

    // Nothing runs without a selection.
    await expect(region.getByRole('button', { name: /Clean up \d+ item/ })).toBeDisabled()
    await derived.getByText('MyApp-abc123', { exact: true }).click()

    const planButton = region.getByRole('button', { name: 'Clean up 1 item…' })
    await expect(planButton).toBeEnabled()
    await planButton.click()

    // The confirmation names the path, the disposal, and the total size.
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Clean up 1 item?')).toBeVisible()
    await expect(
      dialog.getByText('~/Library/Developer/Xcode/DerivedData/MyApp-abc123')
    ).toBeVisible()
    await expect(dialog.getByText(/Total: about 50 MB/)).toBeVisible()

    await dialog.getByRole('button', { name: 'Clean up 1 item' }).click()
    await expect(region.getByRole('status')).toContainText('Cleaned 1 of 1 item.')
    await expect(dialog).toBeHidden()
  })
})
