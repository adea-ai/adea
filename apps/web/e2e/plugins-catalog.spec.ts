import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
})

const require = createRequire(import.meta.url)

test('packed Plugins catalog keeps touch, failure, focus, and activation states clear', async ({
  page,
}) => {
  const path = '/__plugins-catalog'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') })
  const entry = resolve(process.cwd(), 'apps/web/e2e/helpers/plugins-catalog-harness-app.tsx')
  await page.evaluate(async (url) => {
    await import(url)
  }, '/@fs' + entry)

  const dialog = page.getByRole('dialog', { name: 'Plugins', exact: true })
  await expect(dialog.getByRole('region', { name: 'Plugin results', exact: true })).toHaveAttribute(
    'tabindex',
    '0'
  )
  await expect(dialog.getByRole('status').first()).toHaveText('8 plugins')
  await expect(dialog.getByRole('tab', { name: 'Discover' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await dialog.getByRole('tab', { name: 'Navigation (1)', exact: true }).click()
  await expect(dialog.getByText(/Order and show the global rail entries/)).toBeVisible()
  await expect(dialog.getByRole('searchbox', { name: 'Search plugins' })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Move Chat up' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Reset Navigation' })).toBeVisible()
  await expect(dialog.getByText('Active', { exact: true })).toBeVisible()
  await dialog.getByRole('tab', { name: 'Discover', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true)

  const expand = dialog.getByRole('button', {
    name: 'See Sample 4, Sample 5 and more',
    exact: true,
  })
  await expand.scrollIntoViewIfNeeded()
  const bounds = await expand.boundingBox()
  if (!bounds) throw new Error('catalog expansion control is not positioned')
  await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await expect(dialog.getByRole('button', { name: 'Show less', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true'
  )
  await expect(dialog.locator('[data-catalog-entry-id]')).toHaveCount(8)

  const sample = dialog.locator('[data-catalog-entry-id]').filter({ hasText: 'Sample 1' })
  await sample.focus()
  await page.keyboard.press('Enter')
  await expect(dialog.getByRole('heading', { name: 'Sample 1', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Back to plugins' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('The install could not be started.')
  await expect(dialog.getByRole('heading', { name: 'Sample 1', exact: true })).toBeVisible()
  await expect(dialog.getByText('Plugin catalog unavailable')).toHaveCount(0)
  expect(await page.evaluate(() => window.pluginsCatalogHarness.installCalls())).toEqual([
    'plugin:catalog-fixture:sample-1',
  ])

  await dialog.getByRole('button', { name: 'Back to plugins' }).click()
  await expect(sample).toBeFocused()
  const app = dialog.locator('[data-catalog-entry-id]').filter({ hasText: 'Catalog-only app' })
  await app.click()
  await expect(dialog.getByRole('heading', { name: 'Catalog-only app', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Installed', exact: true })).toBeDisabled()
  await expect(
    dialog.getByText(/Activation unavailable: this catalog entry has no bundled first-party/)
  ).toBeVisible()
  // The narrow dialog stacks the detail fields: no side-by-side columns, and
  // no leftover card or divider chrome from the wide layout.
  const stacked = await page.evaluate(() => {
    const sections = [...document.querySelectorAll('.plugins-detail-columns > section')]
    const rects = sections.map((section) => section.getBoundingClientRect())
    return {
      count: sections.length,
      stackedVertically: rects.every(
        (rect, index) => index === 0 || rect.top > rects[index - 1]!.top
      ),
      sharedLeft: new Set(rects.map((rect) => Math.round(rect.left))).size === 1,
      noDividers: sections.every((section) => getComputedStyle(section).borderLeftWidth === '0px'),
    }
  })
  expect(stacked.count).toBeGreaterThanOrEqual(4)
  expect(stacked).toMatchObject({ stackedVertically: true, sharedLeft: true, noDividers: true })

  const axe = await page.evaluate(async () => {
    const pluginDialogElement = document.querySelector('[role="dialog"]')
    if (!pluginDialogElement || !window.axe)
      throw new Error('Plugins dialog or axe-core is missing')
    const results = await window.axe.run(pluginDialogElement, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    })
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target),
    }))
  })
  expect(axe).toEqual([])
})

test.describe('desktop detail layout', () => {
  test.use({ hasTouch: false, isMobile: false, viewport: { width: 1440, height: 900 } })

  test('plugin detail fields share one row of columns split by vertical dividers', async ({
    page,
  }) => {
    const path = '/__plugins-catalog'
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
      '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/plugins-catalog-harness-app.tsx')
    )
    const dialog = page.getByRole('dialog', { name: 'Plugins', exact: true })
    const app = dialog.locator('[data-catalog-entry-id]').filter({ hasText: 'Catalog-only app' })
    await app.click()
    await expect(
      dialog.getByRole('heading', { name: 'Catalog-only app', exact: true })
    ).toBeVisible()

    const layout = await page.evaluate(() => {
      const columns = document.querySelector('.plugins-detail-columns')
      if (!columns) return null
      const sections = [...columns.querySelectorAll<HTMLElement>(':scope > section')]
      const rects = sections.map((section) => section.getBoundingClientRect())
      return {
        count: sections.length,
        titles: sections.map((section) => section.querySelector('h3')?.textContent ?? ''),
        oneRow: rects.every((rect) => Math.abs(rect.top - rects[0]!.top) < 1),
        leftsIncrease: rects.every(
          (rect, index) => index === 0 || rect.left > rects[index - 1]!.left
        ),
        dividersBetween: sections.every((section, index) =>
          index === 0
            ? getComputedStyle(section).borderLeftWidth === '0px'
            : getComputedStyle(section).borderLeftWidth === '1px'
        ),
        noCardRadius: sections.every(
          (section) => getComputedStyle(section).borderTopLeftRadius === '0px'
        ),
        columnsFillRow: Math.abs(rects.at(-1)!.right - columns!.getBoundingClientRect().right) < 2,
      }
    })
    expect(layout).not.toBeNull()
    expect(layout!.count).toBeGreaterThanOrEqual(4)
    expect(layout!.titles).toEqual(['Capabilities', 'Connection', 'Bundle', 'App', 'Activation'])
    expect(layout!.oneRow).toBe(true)
    expect(layout!.leftsIncrease).toBe(true)
    expect(layout!.dividersBetween).toBe(true)
    expect(layout!.noCardRadius).toBe(true)
    expect(layout!.columnsFillRow).toBe(true)
  })
})

type AxeViolations = Readonly<{
  violations: readonly Readonly<{
    id: string
    impact: string | null
    help: string
    nodes: readonly Readonly<{ target: readonly string[] }>[]
  }>[]
}>

declare global {
  interface Window {
    pluginsCatalogHarness: { installCalls(): string[] }
    axe?: {
      run(
        element: Element,
        options: { runOnly: { type: 'tag'; values: string[] } }
      ): Promise<AxeViolations>
    }
  }
}
