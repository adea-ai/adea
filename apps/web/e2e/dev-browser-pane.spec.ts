import { expect, test } from '@playwright/test'

import {
  BROWSER_PANE_HARNESS_PATH,
  browserPaneHarnessHtml,
  browserPaneHarnessModuleSource,
} from './helpers/dev-browser-pane-harness'
import type { ScreenshotRef } from '@adea-ai/types/dev-runtime'

test.use({ headless: true })

async function mountBrowserPane(page: import('@playwright/test').Page, query = '') {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('**' + BROWSER_PANE_HARNESS_PATH + '**', (route) =>
    route.fulfill({ contentType: 'text/html', body: browserPaneHarnessHtml() })
  )
  await page.goto(`${BROWSER_PANE_HARNESS_PATH}${query}`)
  await page.addScriptTag({ type: 'module', content: browserPaneHarnessModuleSource() })
  const pane = page.getByRole('region', { name: 'Browser' })
  await expect(pane).toBeVisible()
  await expect(pane.getByRole('button', { name: 'Screenshot' })).toBeEnabled()
  return pane
}

async function mountDevicesPane(page: import('@playwright/test').Page, query = '') {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('**' + BROWSER_PANE_HARNESS_PATH + '**', (route) =>
    route.fulfill({ contentType: 'text/html', body: browserPaneHarnessHtml() })
  )
  await page.goto(`${BROWSER_PANE_HARNESS_PATH}?pane=devices${query}`)
  await page.addScriptTag({ type: 'module', content: browserPaneHarnessModuleSource() })
  const pane = page.getByRole('region', { name: 'Devices' })
  await expect(pane).toBeVisible()
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
  const pane = await mountBrowserPane(page)
  const urlInput = pane.getByRole('textbox', { name: 'URL' })
  await expect(urlInput).toHaveValue('http://localhost:5173/initial')
  await expect(urlInput).not.toBeFocused()
  await expect(pane.getByRole('button', { name: /^Back/ })).toHaveCount(0)
  await expect(pane.getByRole('button', { name: /^Forward/ })).toHaveCount(0)
  await expect(pane.getByRole('button', { name: 'Open in system browser' })).toHaveCount(0)
  await expect(pane.getByRole('button', { name: /Annotate preview/ })).toHaveCount(0)

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

test('synthetic BrowserPane preview exposes tooltips and supports pointer and keyboard movement', async ({
  page,
}) => {
  // This harness supplies a deterministic fake DevRuntimeService. It verifies
  // UI interaction and geometry, not a packaged browser lane or native runtime.
  const pane = await mountBrowserPane(page)
  const floatPreview = pane.getByRole('button', { name: 'Float preview' })
  await floatPreview.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Toggle the floating browser preview.')
  await floatPreview.click()

  const preview = page.getByRole('region', { name: 'Browser preview', exact: true })
  await expect(preview).toBeVisible()
  await expect.poll(async () => (await preview.boundingBox())?.width ?? 0).toBeGreaterThan(100)

  // The float remount re-homes the pane under the stationary pointer, which
  // opens a pane-edge tooltip synthetically; its card overlaps the header
  // controls until the pointer genuinely leaves, so park the pointer on
  // neutral ground and let the tooltip dismiss before hovering the header.
  await page.mouse.move(640, 450)
  await expect(page.getByRole('tooltip')).toHaveCount(0)

  const move = page.getByRole('button', { name: 'Move Browser preview' })
  await move.hover()
  await expect(
    page.getByRole('tooltip', {
      name: 'Move Browser preview. Use arrow keys to adjust its position.',
    })
  ).toHaveText('Move Browser preview. Use arrow keys to adjust its position.')
  const beforeMove = await preview.boundingBox()
  expect(beforeMove).not.toBeNull()
  await move.focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => (await preview.boundingBox())?.x ?? 0).toBeLessThan(beforeMove!.x)

  const beforePointerMove = await preview.boundingBox()
  const moveBounds = await move.boundingBox()
  expect(beforePointerMove).not.toBeNull()
  expect(moveBounds).not.toBeNull()
  await page.mouse.move(
    moveBounds!.x + moveBounds!.width / 2,
    moveBounds!.y + moveBounds!.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(
    moveBounds!.x + moveBounds!.width / 2 - 20,
    moveBounds!.y + moveBounds!.height / 2 + 15
  )
  await page.mouse.up()
  await expect
    .poll(async () => (await preview.boundingBox())?.x ?? 0)
    .toBeLessThan(beforePointerMove!.x)
  await expect
    .poll(async () => (await preview.boundingBox())?.y ?? 0)
    .toBeGreaterThan(beforePointerMove!.y)

  const resize = page.getByRole('button', { name: 'Resize Browser preview east' })
  await resize.hover()
  await expect(
    page.getByRole('tooltip', {
      name: 'Resize Browser preview from the east edge. Use arrow keys to resize.',
    })
  ).toHaveText('Resize Browser preview from the east edge. Use arrow keys to resize.')
  const beforeResize = await preview.boundingBox()
  expect(beforeResize).not.toBeNull()
  await resize.focus()
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(async () => (await preview.boundingBox())?.width ?? 0)
    .toBeGreaterThan(beforeResize!.width)

  const beforePointerResize = await preview.boundingBox()
  const resizeBounds = await resize.boundingBox()
  expect(beforePointerResize).not.toBeNull()
  expect(resizeBounds).not.toBeNull()
  await page.mouse.move(
    resizeBounds!.x + resizeBounds!.width / 2,
    resizeBounds!.y + resizeBounds!.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(
    resizeBounds!.x + resizeBounds!.width / 2 + 20,
    resizeBounds!.y + resizeBounds!.height / 2
  )
  await page.mouse.up()
  await expect
    .poll(async () => (await preview.boundingBox())?.width ?? 0)
    .toBeGreaterThan(beforePointerResize!.width)

  await page.getByRole('button', { name: 'Close Browser preview' }).click()
  await expect(preview).toHaveCount(0)
})

test('BrowserPane applies the viewport size it reports when zoom changes', async ({ page }) => {
  const pane = await mountBrowserPane(page)
  const viewportCommands = () =>
    page.evaluate(() =>
      window.browserPaneHarness
        .report()
        .commands.filter((command) => command.operation === 'dev.browser.viewport')
    )

  await pane.getByRole('button', { name: 'iPhone 15 Pro' }).click()
  await expect.poll(async () => (await viewportCommands()).length).toBe(1)
  expect((await viewportCommands())[0].body).toMatchObject({ width: 393, height: 852 })
  await expect(pane).toContainText('CSS viewport 393 × 852')

  await pane.getByRole('button', { name: 'Zoom in' }).click()
  await expect.poll(async () => (await viewportCommands()).length).toBe(2)
  expect((await viewportCommands())[1].body).toMatchObject({ width: 432, height: 937 })
  await expect(pane).toContainText('CSS viewport 432 × 937')
})

test('BrowserPane preserves independent viewport results when switching lanes', async ({
  page,
}) => {
  const pane = await mountBrowserPane(page, '?lanes=multiple')
  const laneTabs = pane.getByRole('tablist', { name: 'Browser lanes' }).getByRole('tab')
  const viewportCommands = () =>
    page.evaluate(() =>
      window.browserPaneHarness
        .report()
        .commands.filter((command) => command.operation === 'dev.browser.viewport')
    )

  const firstRequest = await page.evaluate(() => window.browserPaneHarness.deferNextViewport())
  await pane.getByRole('button', { name: 'iPhone 15 Pro' }).click()
  await expect.poll(async () => (await viewportCommands()).length).toBe(1)
  expect((await viewportCommands())[0].body).toMatchObject({
    browserLaneId: 'browser-pane-fixture-lane',
  })

  await laneTabs.nth(1).click()
  const secondRequest = await page.evaluate(() => window.browserPaneHarness.deferNextViewport())
  await pane.getByRole('button', { name: 'Pixel 8' }).click()
  await expect.poll(async () => (await viewportCommands()).length).toBe(2)
  expect((await viewportCommands())[1].body).toMatchObject({
    browserLaneId: 'browser-pane-fixture-lane-2',
  })

  await page.evaluate(
    (requestId) => window.browserPaneHarness.resolveViewport(requestId),
    firstRequest
  )
  await expect(pane).toContainText('Select a preset to set the viewport.')
  await page.evaluate(
    (requestId) => window.browserPaneHarness.resolveViewport(requestId),
    secondRequest
  )
  await expect(pane).toContainText('CSS viewport 412 × 915')

  await laneTabs.nth(0).click()
  await expect(pane).toContainText('CSS viewport 393 × 852')
})

test('BrowserPane refreshes before surfacing a stale viewport generation error', async ({
  page,
}) => {
  const pane = await mountBrowserPane(page)
  const requestId = await page.evaluate(() => window.browserPaneHarness.deferNextViewport())
  await pane.getByRole('button', { name: 'iPhone 15 Pro' }).click()
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.browserPaneHarness
            .report()
            .commands.filter((command) => command.operation === 'dev.browser.viewport').length
      )
    )
    .toBe(1)

  await page.evaluate(() => window.browserPaneHarness.advanceLaneGeneration())
  await page.evaluate(({ id, error }) => window.browserPaneHarness.rejectViewport(id, error), {
    id: requestId,
    error: {
      code: 'stale_generation',
      message: 'browser lane generation moved',
      retryable: false,
    },
  })

  await expect(pane).toContainText('gen 8')
  await expect(pane.getByRole('alert')).toHaveCount(0)
})

test('BrowserPane preserves a newer command error while refreshing a stale viewport lane', async ({
  page,
}) => {
  const pane = await mountBrowserPane(page)
  const requestId = await page.evaluate(() => window.browserPaneHarness.deferNextViewport())
  await pane.getByRole('button', { name: 'iPhone 15 Pro' }).click()
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.browserPaneHarness
            .report()
            .commands.filter((command) => command.operation === 'dev.browser.viewport').length
      )
    )
    .toBe(1)

  await page.evaluate(() => window.browserPaneHarness.deferLaneListRefresh())
  await page.evaluate(() => window.browserPaneHarness.advanceLaneGeneration())
  await page.evaluate(({ id, error }) => window.browserPaneHarness.rejectViewport(id, error), {
    id: requestId,
    error: {
      code: 'stale_generation',
      message: 'browser lane generation moved',
      retryable: false,
    },
  })
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.browserPaneHarness
            .report()
            .commands.filter((command) => command.operation === 'dev.browser.lanes').length
      )
    )
    .toBe(2)

  await page.evaluate(() =>
    window.browserPaneHarness.failNextLaneControl({
      code: 'invalid_state',
      message: 'newer lane control failure',
      retryable: false,
    })
  )
  await pane.getByRole('button', { name: 'Release capture (Esc)' }).click()
  await expect(pane.getByRole('alert')).toContainText('newer lane control failure')

  await page.evaluate(() => window.browserPaneHarness.resolvePendingLaneList())
  await expect(pane.getByRole('alert')).toContainText('newer lane control failure')
})

test('DevicesPane shows host-reported capability guidance and omits unapplied preset controls', async ({
  page,
}) => {
  const pane = await mountDevicesPane(page)

  await expect(pane).toContainText('Xcode Simulator tools are unavailable.')
  await expect(pane).not.toContainText('Android SDK not found.')
  await expect(pane.getByRole('button', { name: 'iPhone 15 Pro' })).toHaveCount(0)
  await expect(pane.getByRole('button', { name: 'Rotate' })).toHaveCount(0)
  await expect(pane).toContainText(
    'Configure responsive viewport size and orientation in the Browser pane.'
  )

  const capabilities = await page.evaluate(() =>
    window.browserPaneHarness
      .report()
      .commands.filter((command) => command.operation === 'dev.device.capabilities')
  )
  expect(capabilities).toHaveLength(1)
})

test('DevicesPane distinguishes installed toolchains with no devices from missing toolchains', async ({
  page,
}) => {
  const pane = await mountDevicesPane(page, '&capabilities=available')

  await expect(pane).not.toContainText('Xcode Simulator tools are unavailable.')
  await expect(pane).not.toContainText('Android SDK not found.')
  await expect(pane.getByText('No devices found.')).toHaveCount(2)
})

test('DevicesPane does not show an empty state before inventory loads', async ({ page }) => {
  const pendingPane = await mountDevicesPane(page, '&capabilities=available&inventory=pending')
  await expect(pendingPane).toContainText('Loading device inventory…')
  await expect(pendingPane.getByText('No devices found.')).toHaveCount(0)
  await page.evaluate(() => window.browserPaneHarness.resolvePendingInventory())
  await expect(pendingPane.getByText('No devices found.')).toHaveCount(2)
})

test('DevicesPane reports inventory errors without showing a false empty state', async ({
  page,
}) => {
  const failedPane = await mountDevicesPane(page, '&capabilities=available&inventory=failed')
  await expect(failedPane).toContainText('Device inventory could not be loaded.')
  await expect(failedPane.getByText('No devices found.')).toHaveCount(0)
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
