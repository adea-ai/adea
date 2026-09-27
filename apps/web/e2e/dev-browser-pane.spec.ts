import { expect, test } from '@playwright/test'

import {
  BROWSER_PANE_HARNESS_PATH,
  browserPaneHarnessHtml,
  browserPaneHarnessModuleSource,
} from './helpers/dev-browser-pane-harness'
import type { ScreenshotRef } from '@adea-ai/types/dev-runtime'

test.use({ headless: true })

async function mountBrowserPane(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('**' + BROWSER_PANE_HARNESS_PATH, (route) =>
    route.fulfill({ contentType: 'text/html', body: browserPaneHarnessHtml() })
  )
  await page.goto(BROWSER_PANE_HARNESS_PATH)
  await page.addScriptTag({ type: 'module', content: browserPaneHarnessModuleSource() })
  const pane = page.getByRole('region', { name: 'Browser' })
  await expect(pane).toBeVisible()
  await expect(pane.getByRole('button', { name: 'Screenshot' })).toBeEnabled()
  return pane
}

function screenshotReference(id: string, redacted = false): ScreenshotRef {
  return {
    id,
    scope: {
      accountId: 'browser-pane-fixture-account',
      workspaceId: 'browser-pane-fixture-workspace',
      runtimeNodeId: 'browser-pane-fixture-node',
    },
    ownerId: 'browser-pane-fixture-owner',
    laneKind: 'task_owned',
    profileId: 'browser-pane-fixture-profile',
    origin: 'http://localhost:5173',
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    redacted,
    contentType: 'image/png',
    byteLength: '987654',
    width: 1280,
    height: 720,
    sha256: 'a'.repeat(64),
    expiresAt: '2099-01-02T03:04:05.000Z',
  }
}

test('BrowserPane port click navigates directly and binds the lane; history stays unavailable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('**' + BROWSER_PANE_HARNESS_PATH, (route) =>
    route.fulfill({ contentType: 'text/html', body: browserPaneHarnessHtml() })
  )
  await page.goto(BROWSER_PANE_HARNESS_PATH)
  await page.addScriptTag({ type: 'module', content: browserPaneHarnessModuleSource() })

  const pane = page.getByRole('region', { name: 'Browser' })
  await expect(pane).toBeVisible()
  const urlInput = pane.getByRole('textbox', { name: 'URL' })
  await expect(urlInput).toHaveValue('http://localhost:5173/initial')
  await expect(urlInput).not.toBeFocused()
  await expect(
    pane.getByRole('button', { name: /Back .*browser history is not supported/ })
  ).toBeDisabled()
  await expect(
    pane.getByRole('button', { name: /Forward .*browser history is not supported/ })
  ).toBeDisabled()

  const portRow = pane.getByRole('button', { name: /localhost:5173/ })
  await expect(portRow).toBeEnabled()
  await portRow.click()

  const navigationCommands = () =>
    page.evaluate(() =>
      window.browserPaneHarness
        .report()
        .commands.filter((command) => command.operation === 'dev.browser.navigate')
    )
  await expect.poll(async () => (await navigationCommands()).length).toBe(1)
  expect(await navigationCommands()).toEqual([
    {
      operation: 'dev.browser.navigate',
      body: {
        browserLaneId: 'browser-pane-fixture-lane',
        expectedGeneration: 7,
        url: 'http://localhost:5173/nested/page?mode=preview#details',
      },
      resource: {
        kind: 'browser_lane',
        id: 'browser-pane-fixture-lane',
        generation: 7,
      },
    },
  ])
  await expect(urlInput).toHaveValue('http://localhost:5173/nested/page?mode=preview#details')

  await pane.getByRole('button', { name: 'Reload' }).click()
  await expect.poll(async () => (await navigationCommands()).length).toBe(2)
  expect((await navigationCommands())[1]).toMatchObject({
    operation: 'dev.browser.navigate',
    body: {
      browserLaneId: 'browser-pane-fixture-lane',
      expectedGeneration: 7,
      url: 'http://localhost:5173/nested/page?mode=preview#details',
    },
    resource: {
      kind: 'browser_lane',
      id: 'browser-pane-fixture-lane',
      generation: 7,
    },
  })
})

test('BrowserPane inspects a CSS selector on the active page with a generation-bound command', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('**' + BROWSER_PANE_HARNESS_PATH, (route) =>
    route.fulfill({ contentType: 'text/html', body: browserPaneHarnessHtml() })
  )
  await page.goto(BROWSER_PANE_HARNESS_PATH)
  await page.addScriptTag({ type: 'module', content: browserPaneHarnessModuleSource() })

  const pane = page.getByRole('region', { name: 'Browser' })
  const selector = pane.getByRole('textbox', { name: 'CSS selector' })
  const inspect = pane.getByRole('button', { name: 'Inspect selector' })
  await expect(pane).toBeVisible()
  await expect(inspect).toBeDisabled()

  await selector.fill('button[data-action="send"]')
  await expect(inspect).toBeEnabled()
  await inspect.click()

  const inspections = () =>
    page.evaluate(() =>
      window.browserPaneHarness
        .report()
        .commands.filter((command) => command.operation === 'dev.browser.inspect')
    )
  await expect.poll(async () => (await inspections()).length).toBe(1)
  expect(await inspections()).toEqual([
    {
      operation: 'dev.browser.inspect',
      body: {
        browserLaneId: 'browser-pane-fixture-lane',
        expectedGeneration: 7,
        targetId: 'browser-pane-fixture-target',
        selector: 'button[data-action="send"]',
      },
      resource: {
        kind: 'browser_lane',
        id: 'browser-pane-fixture-lane',
        generation: 7,
      },
    },
  ])

  const result = pane.getByRole('status', { name: 'Inspection result' })
  await expect(result).toContainText('button')
  await expect(result).toContainText('Submit request')
  await expect(result).toContainText('x 12 · y 24 · width 80 · height 32')

  await pane.getByRole('button', { name: 'iPhone 15 Pro' }).click()
  await expect(result).toHaveCount(0)
})

test('BrowserPane renders screenshot reference metadata and exact host redaction classification only', async ({
  page,
}) => {
  const pane = await mountBrowserPane(page)
  const deferredId = await page.evaluate(() => window.browserPaneHarness.deferNextScreenshot())
  const screenshot = pane.getByRole('button', { name: 'Screenshot' })
  await screenshot.click()
  await expect(screenshot).toBeDisabled()
  await page.evaluate(({ id, ref }) => window.browserPaneHarness.resolveScreenshot(id, ref), {
    id: deferredId,
    ref: screenshotReference('00000000-0000-4000-8000-000000000001'),
  })

  const result = pane.getByRole('status', { name: 'Screenshot result' })
  await expect(result).toContainText('Reference: 00000000-0000-4000-8000-000000000001')
  await expect(result).toContainText('Dimensions: 1280 × 720')
  await expect(result).toContainText('Content type: image/png')
  await expect(result).toContainText('Expires: 2099-01-02T03:04:05.000Z')
  await expect(result).toContainText('Redacted: false')
  await expect(result.locator('img')).toHaveCount(0)
  await expect(result).not.toContainText('987654')
  await expect(result).not.toContainText('byteLength')

  const commands = await page.evaluate(() =>
    window.browserPaneHarness
      .report()
      .commands.filter((command) => command.operation === 'dev.browser.screenshot')
  )
  expect(commands).toHaveLength(1)
  expect(commands[0]).toMatchObject({
    body: {
      browserLaneId: 'browser-pane-fixture-lane',
      expectedGeneration: 7,
      targetId: 'browser-pane-fixture-target',
      format: 'png',
    },
    resource: {
      kind: 'browser_lane',
      id: 'browser-pane-fixture-lane',
      generation: 7,
    },
  })

  await pane.getByRole('button', { name: 'Reload' }).click()
  await expect(result).toHaveCount(0)
})

test('BrowserPane ignores a late screenshot success after lane generation changes and accepts a fresh capture', async ({
  page,
}) => {
  const pane = await mountBrowserPane(page)
  const deferredId = await page.evaluate(() => window.browserPaneHarness.deferNextScreenshot())
  await pane.getByRole('button', { name: 'Screenshot' }).click()
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.browserPaneHarness
            .report()
            .commands.filter((command) => command.operation === 'dev.browser.screenshot').length
      )
    )
    .toBe(1)

  await pane.getByRole('button', { name: 'Release capture (Esc)' }).click()
  await expect(pane).toContainText('gen 8')
  await page.evaluate(({ id, ref }) => window.browserPaneHarness.resolveScreenshot(id, ref), {
    id: deferredId,
    ref: screenshotReference('00000000-0000-4000-8000-000000000008'),
  })
  await expect(pane.getByRole('status', { name: 'Screenshot result' })).toHaveCount(0)

  await pane.getByRole('button', { name: 'Screenshot' }).click()
  await expect(pane.getByRole('status', { name: 'Screenshot result' })).toContainText(
    'Reference: 00000000-0000-4000-8000-000000000001'
  )
})

test('BrowserPane ignores a late screenshot error after lane generation changes', async ({
  page,
}) => {
  const pane = await mountBrowserPane(page)
  const deferredId = await page.evaluate(() => window.browserPaneHarness.deferNextScreenshot())
  await pane.getByRole('button', { name: 'Screenshot' }).click()
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.browserPaneHarness
            .report()
            .commands.filter((command) => command.operation === 'dev.browser.screenshot').length
      )
    )
    .toBe(1)

  await pane.getByRole('button', { name: 'Release capture (Esc)' }).click()
  await expect(pane).toContainText('gen 8')
  await page.evaluate(({ id, error }) => window.browserPaneHarness.rejectScreenshot(id, error), {
    id: deferredId,
    error: {
      code: 'stale_generation',
      retryable: false,
      message: 'capture belongs to the previous lane generation',
    },
  })
  await expect(pane.getByRole('alert')).toHaveCount(0)

  await pane.getByRole('button', { name: 'Screenshot' }).click()
  await expect(pane.getByRole('status', { name: 'Screenshot result' })).toContainText(
    'Reference: 00000000-0000-4000-8000-000000000001'
  )
})

test('BrowserPane keeps the latest screenshot result visible while a newer capture is busy', async ({
  page,
}) => {
  const pane = await mountBrowserPane(page)
  const screenshot = pane.getByRole('button', { name: 'Screenshot' })
  await screenshot.click()

  const result = pane.getByRole('status', { name: 'Screenshot result' })
  await expect(result).toContainText('Reference: 00000000-0000-4000-8000-000000000001')
  const deferredId = await page.evaluate(() => window.browserPaneHarness.deferNextScreenshot())
  await screenshot.click()
  await expect(result).toContainText('Reference: 00000000-0000-4000-8000-000000000001')
  await expect(screenshot).toBeDisabled()
  await expect(result).toHaveAttribute('aria-busy', 'true')

  await page.evaluate(({ id, ref }) => window.browserPaneHarness.resolveScreenshot(id, ref), {
    id: deferredId,
    ref: screenshotReference('00000000-0000-4000-8000-000000000009', true),
  })
  await expect(screenshot).toBeEnabled()
  await expect(result).toContainText('Reference: 00000000-0000-4000-8000-000000000009')
  await expect(result).toContainText('Redacted: true')
  await expect(result).not.toContainText('Reference: 00000000-0000-4000-8000-000000000001')
})

test('BrowserPane recovers from a typed screenshot host error', async ({ page }) => {
  const pane = await mountBrowserPane(page)
  await page.evaluate(() =>
    window.browserPaneHarness.failNextScreenshot({
      code: 'capability_unavailable',
      retryable: true,
      message: 'screenshot capture is unavailable on this lane',
    })
  )
  const screenshot = pane.getByRole('button', { name: 'Screenshot' })
  await screenshot.click()
  await expect(pane.getByRole('alert')).toContainText(
    'capability_unavailable: screenshot capture is unavailable on this lane'
  )

  await screenshot.click()
  await expect(pane.getByRole('alert')).toHaveCount(0)
  await expect(pane.getByRole('status', { name: 'Screenshot result' })).toContainText(
    'Reference: 00000000-0000-4000-8000-000000000001'
  )
})

test('BrowserPane clears screenshot metadata when the emulated viewport changes', async ({
  page,
}) => {
  const pane = await mountBrowserPane(page)
  const screenshot = pane.getByRole('button', { name: 'Screenshot' })
  await screenshot.click()
  const result = pane.getByRole('status', { name: 'Screenshot result' })
  await expect(result).toBeVisible()

  await pane.getByRole('button', { name: 'iPhone 15 Pro' }).click()
  await expect(result).toHaveCount(0)
})

test('BrowserPane invalidates a pending screenshot on unmount', async ({ page }) => {
  const pane = await mountBrowserPane(page)
  const deferredId = await page.evaluate(() => window.browserPaneHarness.deferNextScreenshot())
  await pane.getByRole('button', { name: 'Screenshot' }).click()
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.browserPaneHarness
            .report()
            .commands.filter((command) => command.operation === 'dev.browser.screenshot').length
      )
    )
    .toBe(1)

  await page.evaluate(() => window.browserPaneHarness.unmount())
  await page.evaluate(({ id, ref }) => window.browserPaneHarness.resolveScreenshot(id, ref), {
    id: deferredId,
    ref: screenshotReference('00000000-0000-4000-8000-000000000010'),
  })
  await expect(pane).toHaveCount(0)
})
