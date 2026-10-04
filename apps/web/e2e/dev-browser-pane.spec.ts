import { expect, test } from '@playwright/test'

import {
  BROWSER_PANE_HARNESS_PATH,
  browserPaneHarnessHtml,
  browserPaneHarnessModuleSource,
} from './helpers/dev-browser-pane-harness'
import {
  browserPaneFixtureScope,
  fixtureCookiePlanDigest,
  fixtureCookiePlanId,
} from './helpers/dev-browser-pane-cookie-fixtures'
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

async function mountResourcesPane(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('**' + BROWSER_PANE_HARNESS_PATH + '**', (route) =>
    route.fulfill({ contentType: 'text/html', body: browserPaneHarnessHtml() })
  )
  await page.goto(`${BROWSER_PANE_HARNESS_PATH}?pane=resources`)
  await page.addScriptTag({ type: 'module', content: browserPaneHarnessModuleSource() })
  const pane = page.getByRole('region', { name: 'Runtime resources' })
  await expect(pane).toBeVisible()
  await expect(pane.locator('.dev-resources__code')).toHaveText('localhost:5173')
  return pane
}

async function expectFontLoaded(page: import('@playwright/test').Page, family: string) {
  await expect
    .poll(() =>
      page.evaluate(
        (name) =>
          [...document.fonts].some(
            (face) => face.family.includes(name) && face.status === 'loaded'
          ),
        family
      )
    )
    .toBe(true)
}

function screenshotReference(id: string, redacted = false): ScreenshotRef {
  return {
    id,
    scope: browserPaneFixtureScope,
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
  const laneButtons = pane.getByRole('group', { name: 'Browser lanes' }).getByRole('button')
  await expect(laneButtons.nth(0)).toHaveAttribute('aria-current', 'true')
  await expect(laneButtons.nth(1)).not.toHaveAttribute('aria-current')
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

  await laneButtons.nth(1).click()
  await expect(laneButtons.nth(1)).toHaveAttribute('aria-current', 'true')
  await expect(laneButtons.nth(0)).not.toHaveAttribute('aria-current')
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

  await laneButtons.nth(0).click()
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

// ── #718: the annotation surface ─────────────────────────────────────────────

async function mountAnnotateSurface(page: import('@playwright/test').Page, query = '') {
  const pane = await mountBrowserPane(page, query)
  await pane.getByRole('button', { name: 'Annotate frame' }).click()
  const annotate = pane.getByRole('region', { name: 'Annotate frame' })
  await expect(annotate).toBeVisible()
  const surface = annotate.getByRole('application', { name: /Annotate frame for/ })
  await expect(surface).toBeVisible()
  return { pane, annotate, surface }
}

async function dragRegion(
  page: import('@playwright/test').Page,
  surface: import('@playwright/test').Locator,
  from: { x: number; y: number },
  to: { x: number; y: number }
) {
  const box = (await surface.boundingBox())!
  await page.mouse.move(box.x + box.width * from.x, box.y + box.height * from.y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * to.x, box.y + box.height * to.y)
  await page.mouse.up()
}

const annotateCommands = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    window.browserPaneHarness
      .report()
      .commands.filter((command) => command.operation === 'dev.browser.annotate')
  )

test('BrowserPane disables annotate with a reason while the lane is agent-owned', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('**' + BROWSER_PANE_HARNESS_PATH + '**', (route) =>
    route.fulfill({ contentType: 'text/html', body: browserPaneHarnessHtml() })
  )
  await page.goto(`${BROWSER_PANE_HARNESS_PATH}?owner=agent`)
  await page.addScriptTag({ type: 'module', content: browserPaneHarnessModuleSource() })
  const pane = page.getByRole('region', { name: 'Browser' })
  await expect(pane).toBeVisible()

  const annotate = pane.getByRole('button', { name: 'Annotate frame' })
  await expect(annotate).toBeDisabled()
  await annotate.hover()
  await expect(page.getByRole('tooltip')).toContainText('agent-owned')
})

test('BrowserPane submits a dragged region bound to lane, target, and generation', async ({
  page,
}) => {
  const { annotate, surface } = await mountAnnotateSurface(page)
  await dragRegion(page, surface, { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.5 })

  const draft = annotate.getByRole('status').filter({ hasText: /Region at/ })
  await expect(draft).toContainText('Region at 20,20')

  const deferredId = await page.evaluate(() => window.browserPaneHarness.deferNextAnnotate())
  await annotate.getByRole('button', { name: 'Submit annotation' }).click()
  await expect(annotate.getByRole('button', { name: 'Region (R)', exact: true })).toBeDisabled()
  await expect(annotate.getByRole('button', { name: 'Note (N)', exact: true })).toBeDisabled()
  await surface.press('Enter')
  await surface.press('ArrowRight')
  await expect(draft).toContainText('Region at 20,20')

  const commands = await annotateCommands(page)
  expect(commands).toHaveLength(1)
  expect(commands[0].body.browserLaneId).toBe('browser-pane-fixture-lane')
  expect(commands[0].body.expectedGeneration).toBe(7)
  expect(commands[0].body.targetId).toBe('browser-pane-fixture-target')
  const annotation = commands[0].body.annotation as Record<string, unknown>
  expect(annotation.kind).toBe('rect')
  expect(annotation.targetId).toBe('browser-pane-fixture-target')
  expect(annotation.x).toBeCloseTo(0.2, 2)
  expect(annotation.y).toBeCloseTo(0.2, 2)
  expect(annotation.width).toBeCloseTo(0.4, 2)
  expect(annotation.height).toBeCloseTo(0.3, 2)
  expect(commands[0].resource).toEqual({
    kind: 'browser_lane',
    id: 'browser-pane-fixture-lane',
    generation: 7,
  })

  await page.evaluate(
    (id) =>
      window.browserPaneHarness.resolveAnnotate(id, {
        targetId: 'browser-pane-fixture-target',
        kind: 'rect',
        x: 0.2,
        y: 0.2,
        width: 0.4,
        height: 0.3,
        id: '00000000-0000-4000-8000-00000000a001',
        screenshotId: '00000000-0000-4000-8000-00000000b002',
        createdAt: '2099-01-01T00:00:00.000Z',
      }),
    deferredId
  )
  const result = annotate.getByRole('status', { name: 'Annotation result' })
  await expect(result).toContainText('annotation 00000000')
  await expect(result).toContainText('screenshot 00000000')
  await expect(result.locator('img')).toHaveCount(0)

  // Successful completion must release the pending gate for the next draft.
  await dragRegion(page, surface, { x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 })
  await expect(annotate.getByRole('button', { name: 'Submit annotation' })).toBeEnabled()
  await annotate.getByRole('button', { name: 'Submit annotation' }).click()
  await expect.poll(async () => (await annotateCommands(page)).length).toBe(2)
})

test('BrowserPane starts and adjusts an annotation without a pointer', async ({ page }) => {
  const { surface } = await mountAnnotateSurface(page)
  await surface.focus()
  await surface.press('Space')
  await surface.press('ArrowRight')
  await surface.press('Enter')
  await expect.poll(async () => (await annotateCommands(page)).length).toBe(1)
  const commands = await annotateCommands(page)
  const annotation = commands[0].body.annotation as Record<string, number | string>
  expect(annotation.kind).toBe('rect')
  expect(annotation.x).toBeCloseTo(0.26, 2)
  expect(annotation.y).toBeCloseTo(0.25, 2)
  expect(annotation.width).toBeCloseTo(0.5, 2)
  expect(annotation.height).toBeCloseTo(0.5, 2)
})

test('BrowserPane ignores a cancelled annotation failure and accepts a new draft', async ({
  page,
}) => {
  const { annotate, surface } = await mountAnnotateSurface(page)
  await dragRegion(page, surface, { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.5 })
  const deferredId = await page.evaluate(() => window.browserPaneHarness.deferNextAnnotate())
  await annotate.getByRole('button', { name: 'Submit annotation' }).click()
  await surface.press('Escape')
  await page.evaluate(
    (id) =>
      window.browserPaneHarness.rejectAnnotate(id, {
        code: 'invalid_state',
        retryable: false,
        message: 'Obsolete annotation failed',
      }),
    deferredId
  )

  await dragRegion(page, surface, { x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 })
  await expect(annotate.getByRole('alert', { name: 'Annotation error' })).toHaveCount(0)
  await expect(annotate.getByRole('button', { name: 'Submit annotation' })).toBeEnabled()
  await annotate.getByRole('button', { name: 'Submit annotation' }).click()
  await expect.poll(async () => (await annotateCommands(page)).length).toBe(2)
})

test('BrowserPane adjusts a region with arrow keys and submits with Enter', async ({ page }) => {
  const { annotate, surface } = await mountAnnotateSurface(page)
  await dragRegion(page, surface, { x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 })
  await surface.press('ArrowRight')
  await surface.press('ArrowDown')
  await surface.press('Shift+ArrowRight')

  await annotate.getByRole('button', { name: 'Submit annotation' }).click()
  const commands = await annotateCommands(page)
  expect(commands).toHaveLength(1)
  const annotation = commands[0].body.annotation as Record<string, number>
  expect(annotation.x).toBeCloseTo(0.21, 2)
  expect(annotation.y).toBeCloseTo(0.21, 2)
  expect(annotation.width).toBeCloseTo(0.31, 2)
  expect(annotation.height).toBeCloseTo(0.3, 2)
})

test('BrowserPane discards the pending annotation on Escape and exits on the second press', async ({
  page,
}) => {
  const { pane, annotate, surface } = await mountAnnotateSurface(page)
  await dragRegion(page, surface, { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.5 })
  await expect(annotate.getByRole('status').filter({ hasText: /Region at/ })).toBeVisible()

  await surface.press('Escape')
  await expect(annotate.getByRole('status').filter({ hasText: /No region marked/ })).toBeVisible()
  await expect(annotate.getByRole('button', { name: 'Submit annotation' })).toBeDisabled()
  expect(await annotateCommands(page)).toHaveLength(0)

  await surface.press('Escape')
  await expect(annotate).toHaveCount(0)
  await expect(pane.getByRole('button', { name: 'Annotate frame' })).toBeFocused()
})

test('BrowserPane discards a pending draft through the discard control without a command', async ({
  page,
}) => {
  const { annotate, surface } = await mountAnnotateSurface(page)
  await dragRegion(page, surface, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.6 })
  await annotate.getByRole('button', { name: 'Discard draft' }).click()
  await expect(annotate.getByRole('status').filter({ hasText: /No region marked/ })).toBeVisible()
  await expect(annotate.getByRole('button', { name: 'Submit annotation' })).toBeDisabled()
  expect(await annotateCommands(page)).toHaveLength(0)
})

test('BrowserPane anchors a note with text and submits it as a text annotation', async ({
  page,
}) => {
  const { annotate, surface } = await mountAnnotateSurface(page)
  await annotate.getByRole('button', { name: 'Note (N)' }).click()
  await page.mouse.click(
    (await surface.boundingBox())!.x + 64,
    (await surface.boundingBox())!.y + 48
  )
  await annotate.getByRole('textbox', { name: 'Note text' }).fill('Badge overlaps the heading')
  await annotate.getByRole('textbox', { name: 'Note text' }).press('Enter')

  const commands = await annotateCommands(page)
  expect(commands).toHaveLength(1)
  const annotation = commands[0].body.annotation as Record<string, unknown>
  expect(annotation.kind).toBe('text')
  expect(annotation.text).toBe('Badge overlaps the heading')
  expect(annotation.x).toBeGreaterThan(0)
  expect(annotation.y).toBeGreaterThan(0)
})

test('BrowserPane reports a typed annotate failure without clearing the draft', async ({
  page,
}) => {
  const { annotate, surface } = await mountAnnotateSurface(page)
  await dragRegion(page, surface, { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.5 })
  const deferredId = await page.evaluate(() => window.browserPaneHarness.deferNextAnnotate())
  await annotate.getByRole('button', { name: 'Submit annotation' }).click()
  await page.evaluate(
    (id) =>
      window.browserPaneHarness.rejectAnnotate(id, {
        code: 'stale_generation',
        message: 'lane generation moved',
        retryable: false,
      }),
    deferredId
  )
  const alert = annotate.getByRole('alert', { name: 'Annotation error' })
  await expect(alert).toContainText('stale_generation')
  await expect(annotate.getByRole('status').filter({ hasText: /Region at/ })).toBeVisible()
})

test('BrowserPane discards a late annotation completion after the canonical session changes', async ({
  page,
}) => {
  const { pane, annotate, surface } = await mountAnnotateSurface(page, '?context-control=enabled')
  await dragRegion(page, surface, { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.5 })
  const requestId = await page.evaluate(() => window.browserPaneHarness.deferNextAnnotate())
  await annotate.getByRole('button', { name: 'Submit annotation' }).click()
  await expect.poll(async () => (await annotateCommands(page)).length).toBe(1)

  await page.getByRole('button', { name: 'Switch runtime session' }).click()
  await expect(page.getByTestId('canonical-session')).toHaveText('browser-pane-fixture-session-2')
  await expect(pane.getByRole('region', { name: 'Annotate frame' })).toBeVisible()

  await page.evaluate(
    (id) =>
      window.browserPaneHarness.resolveAnnotate(id, {
        targetId: 'browser-pane-fixture-target',
        kind: 'rect',
        x: 0.2,
        y: 0.2,
        width: 0.4,
        height: 0.3,
        id: '00000000-0000-4000-8000-00000000a001',
        screenshotId: '00000000-0000-4000-8000-00000000b002',
        createdAt: '2099-01-01T00:00:00.000Z',
      }),
    requestId
  )

  await expect(pane.getByRole('status', { name: 'Annotation result' })).toHaveCount(0)
  await expect(pane.getByRole('alert', { name: 'Annotation error' })).toHaveCount(0)
})

// ── Cookie import (#646): sources → preview → confirm ──────────────────────
// The harness serves decoder-exact fixture replies for the three cookie
// operations (pinned in apps/web/test/browser-pane-cookie-fixtures.test.ts),
// so this lane renders the same wire shapes the packaged app decodes.

function chromePreviewButton(pane: import('@playwright/test').Locator) {
  return pane
    .locator('.dev-browser__diagnostic', { hasText: 'Google Chrome — Default' })
    .getByRole('button', { name: 'Preview import' })
}

test('BrowserPane discards a late cookie plan after the canonical session changes', async ({
  page,
}) => {
  const pane = await mountBrowserPane(page, '?context-control=enabled')
  await pane.getByRole('button', { name: 'Import cookies' }).click()
  await expect(chromePreviewButton(pane)).toBeEnabled()

  const requestId = await page.evaluate(() => window.browserPaneHarness.deferNextCookiePlan())
  await chromePreviewButton(pane).click()
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.browserPaneHarness
            .report()
            .commands.filter((command) => command.operation === 'dev.browser.cookieImportPlan')
            .length
      )
    )
    .toBe(1)

  await page.getByRole('button', { name: 'Switch runtime session' }).click()
  await expect(page.getByTestId('canonical-session')).toHaveText('browser-pane-fixture-session-2')
  await expect(chromePreviewButton(pane)).toBeVisible()
  await expect(pane.locator('.dev-browser__cookies-preview')).toHaveCount(0)

  await page.evaluate((id) => window.browserPaneHarness.resolveCookiePlan(id), requestId)
  await expect(pane.locator('.dev-browser__cookies-preview')).toHaveCount(0)
  await expect(pane.getByText('12 cookies to import')).toHaveCount(0)
})

test('BrowserPane does not show a late cookie commit after the lane generation changes', async ({
  page,
}) => {
  const pane = await mountBrowserPane(page)
  await pane.getByRole('button', { name: 'Import cookies' }).click()
  await chromePreviewButton(pane).click()
  const preview = pane.locator('.dev-browser__cookies-preview')
  await expect(preview).toContainText('12 cookies to import')

  // A closed lane makes this fixture commit succeed if its old response is
  // applied. The subsequent takeover changes generation while that response
  // is held, so the old keyed panel must not publish its result into the new
  // generation's cookie surface.
  await page.evaluate(() => window.browserPaneHarness.closeFixtureLane())
  const requestId = await page.evaluate(() => window.browserPaneHarness.deferNextCookieCommit())
  await pane.getByRole('button', { name: 'Import to this lane' }).click()
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.browserPaneHarness
            .report()
            .commands.filter((command) => command.operation === 'dev.browser.cookieImportCommit')
            .length
      )
    )
    .toBe(1)

  await pane.getByRole('button', { name: 'Release capture (Esc)' }).click()
  await expect(pane.getByText('gen 8', { exact: true })).toBeVisible()
  await expect(chromePreviewButton(pane)).toBeVisible()
  await expect(pane.locator('.dev-browser__cookies-preview')).toHaveCount(0)

  await page.evaluate((id) => window.browserPaneHarness.resolveCookieCommit(id), requestId)
  await expect(pane.getByText('12 cookies imported · 3 skipped.')).toHaveCount(0)
  await expect(pane.locator('.dev-browser__cookies-preview')).toHaveCount(0)
})

test('BrowserPane cookie import renders typed sources, previews the value-free plan, and commits a stopped lane', async ({
  page,
}) => {
  const pane = await mountBrowserPane(page)
  await pane.getByRole('button', { name: 'Import cookies' }).click()

  // One typed row per detected profile; a browser this runtime cannot read is
  // a row that states why, never an absence that reads as "no browsers".
  await expect(pane.getByText('Google Chrome — Default')).toBeVisible()
  const firefoxRow = pane.locator('.dev-browser__diagnostic', { hasText: 'Firefox — dev' })
  await expect(
    firefoxRow.getByText('Locked by the browser. Quit it and reload the sources to import.')
  ).toBeVisible()
  await expect(firefoxRow.getByRole('button', { name: 'Preview import' })).toBeDisabled()
  const safariRow = pane.locator('.dev-browser__diagnostic', { hasText: 'Safari' })
  await expect(
    safariRow.getByText('This profile stores cookies in a format this runtime cannot read.')
  ).toBeVisible()
  await expect(safariRow.getByRole('button', { name: 'Preview import' })).toBeDisabled()

  const previewButton = chromePreviewButton(pane)
  await expect(previewButton).toBeEnabled()
  await previewButton.click()

  const preview = pane.locator('.dev-browser__cookies-preview')
  await expect(
    preview.getByText('12 cookies to import · 4 cookies replaced · 3 skipped across 2 families.')
  ).toBeVisible()
  await expect(preview.getByText('example.com, github.com')).toBeVisible()
  // The wire plan is value-free and so is the surface: nothing value-shaped
  // may appear anywhere in the preview.
  const previewText = await preview.innerText()
  expect(previewText).not.toMatch(/value|token|secret/i)

  // While the lane engine owns the profile the commit is a typed refusal, and
  // the plan stays on screen so the reader can retry after stopping the lane.
  await pane.getByRole('button', { name: 'Import to this lane' }).click()
  await expect(pane.getByRole('alert')).toContainText(
    'close the browser lane before importing cookies (lane is ready)'
  )
  await expect(preview).toContainText('12 cookies to import')

  // Stop the lane; the same plan digest then commits.
  await page.evaluate(() => window.browserPaneHarness.closeFixtureLane())
  await pane.getByRole('button', { name: 'Import to this lane' }).click()
  await expect(pane.getByText('12 cookies imported · 3 skipped.')).toBeVisible()
  await expect(preview).toHaveCount(0)

  // The plan binds the lane in its resource; the commit body is exactly the
  // plan id plus digest — the lane never travels in the commit body.
  const commands = await page.evaluate(() => window.browserPaneHarness.report().commands)
  const planCommand = commands.find(
    (command) => command.operation === 'dev.browser.cookieImportPlan'
  )
  expect(planCommand).toMatchObject({
    body: {
      browserLaneId: 'browser-pane-fixture-lane',
      domains: [],
      expectedGeneration: 7,
      sourceProfileId: 'chrome:Default',
    },
    resource: { kind: 'browser_lane', id: 'browser-pane-fixture-lane', generation: 7 },
  })
  const commitCommands = commands.filter(
    (command) => command.operation === 'dev.browser.cookieImportCommit'
  )
  expect(commitCommands).toHaveLength(2)
  for (const commit of commitCommands) {
    expect(Object.keys(commit.body).toSorted()).toEqual(['planDigest', 'planId'])
    expect(commit.body).toEqual({
      planDigest: fixtureCookiePlanDigest,
      planId: fixtureCookiePlanId,
    })
    expect(commit.resource).toEqual({
      kind: 'browser_lane',
      id: 'browser-pane-fixture-lane',
      generation: 7,
    })
  }
})

test('BrowserPane cookie import surfaces a denied Keychain as typed guidance, never an empty success', async ({
  page,
}) => {
  const pane = await mountBrowserPane(page, '?cookies=keychain')
  await pane.getByRole('button', { name: 'Import cookies' }).click()
  await chromePreviewButton(pane).click()

  await expect(pane.getByRole('alert')).toContainText(
    'Keychain item could not be read; cookies are never written unencrypted'
  )
  // A refusal produces no plan and no commit affordance to pretend with.
  await expect(pane.locator('.dev-browser__cookies-preview')).toHaveCount(0)
  await expect(pane.getByRole('button', { name: 'Import to this lane' })).toHaveCount(0)
})

test('BrowserPane cookie import reports a stale plan instead of guessing what moved', async ({
  page,
}) => {
  const pane = await mountBrowserPane(page, '?cookies=stale')
  await pane.getByRole('button', { name: 'Import cookies' }).click()
  await chromePreviewButton(pane).click()

  const preview = pane.locator('.dev-browser__cookies-preview')
  await expect(preview).toContainText('12 cookies to import')

  await page.evaluate(() => window.browserPaneHarness.closeFixtureLane())
  await pane.getByRole('button', { name: 'Import to this lane' }).click()
  await expect(pane.getByRole('alert')).toContainText(
    'lane generation moved to 8; preview the import again'
  )
  // The refused plan stays readable for the re-preview the guidance asks for.
  await expect(preview).toContainText('12 cookies to import')
})

test('BrowserPane cookie import renders a failed source read as typed guidance, not an empty list', async ({
  page,
}) => {
  const pane = await mountBrowserPane(page, '?cookies=sources-unavailable')
  await pane.getByRole('button', { name: 'Import cookies' }).click()

  await expect(pane.getByRole('alert')).toContainText('fixture cookie source read failed')
  await expect(
    pane.getByText(
      'No browser profiles with a readable cookie store were detected on this machine.'
    )
  ).toHaveCount(0)
})

test('BrowserPane cookie import refuses the commit while the plan carries a blocker', async ({
  page,
}) => {
  const pane = await mountBrowserPane(page, '?cookies=blocked')
  await pane.getByRole('button', { name: 'Import cookies' }).click()
  await chromePreviewButton(pane).click()

  await expect(pane.getByRole('alert')).toContainText(
    'the lane engine still owns this profile; close the lane before importing'
  )
  await expect(pane.getByRole('button', { name: 'Import to this lane' })).toBeDisabled()
})

test('BrowserPane and ResourcesPane project the shared UI, Content, and Code font roles', async ({
  page,
}) => {
  const { pane, annotate, surface } = await mountAnnotateSurface(page)
  const uiRow = pane.locator('.dev-browser__row').first()
  await expect(uiRow).toHaveCSS('font-size', '12.8px')

  const settings = {
    ui: { family: 'space-grotesk', size: 28 },
    content: { family: 'geist', size: 18 },
    code: { family: 'jetbrains-mono', size: 16 },
  } as const
  await page.evaluate((fonts) => window.browserPaneHarness.setFonts(fonts), settings)
  await expectFontLoaded(page, 'Space Grotesk')
  await expect(uiRow).toHaveCSS('font-size', '25.6px')
  await expect(uiRow).toHaveCSS('font-family', /Space Grotesk/)

  const selector = pane.getByRole('textbox', { name: 'CSS selector' })
  await selector.fill('button')
  await pane.getByRole('button', { name: 'Inspect selector' }).click()
  const inspection = pane.getByRole('status', { name: 'Inspection result' })
  await expect(inspection).toContainText('Submit request')
  await expectFontLoaded(page, 'JetBrains Mono')
  await expect(inspection).toHaveCSS('font-size', '16px')
  await expect(inspection).toHaveCSS('font-family', /JetBrains Mono/)

  await expect(annotate).toBeVisible()
  await annotate.getByRole('button', { name: 'Note (N)' }).click()
  // Notes annotate a point in the frame; text alone is not an annotation.
  await surface.click({ position: { x: 40, y: 40 } })
  const note = annotate.getByRole('textbox', { name: 'Note text' })
  await note.fill('This annotation uses readable content typography.')
  await note.press('Enter')
  const annotation = annotate.getByRole('status', { name: 'Annotation result' })
  await expect(annotation).toBeVisible()
  await expectFontLoaded(page, 'Geist')
  await expect(annotation).toHaveCSS('font-size', '18px')
  await expect(annotation).toHaveCSS('font-family', /Geist/)

  const smallerCodeSettings = { ...settings, code: { family: 'jetbrains-mono', size: 12 } } as const
  await page.evaluate((fonts) => window.browserPaneHarness.setFonts(fonts), smallerCodeSettings)
  await expect(inspection).toHaveCSS('font-size', '12px')
  await expect(uiRow).toHaveCSS('font-size', '25.6px')
  await expect(annotation).toHaveCSS('font-size', '18px')

  await page.evaluate(() => window.browserPaneHarness.resetFonts())
  await expect(annotation).toHaveCSS('font-size', '14px')
  await expect(inspection).toHaveCSS('font-size', '12px')

  const resources = await mountResourcesPane(page)
  const resourceUi = resources.locator('.dev-resources__row-detail').first()
  const resourceContent = resources.locator('.dev-resources__note').first()
  const resourceCode = resources.locator('.dev-resources__code').first()
  await page.evaluate((fonts) => window.browserPaneHarness.setFonts(fonts), settings)
  await expectFontLoaded(page, 'Space Grotesk')
  await expectFontLoaded(page, 'Geist')
  await expectFontLoaded(page, 'JetBrains Mono')
  await expect(resourceUi).toHaveCSS('font-size', '24px')
  await expect(resourceUi).toHaveCSS('font-family', /Space Grotesk/)
  await expect(resourceContent).toHaveCSS('font-size', '18px')
  await expect(resourceContent).toHaveCSS('font-family', /Geist/)
  await expect(resourceCode).toHaveCSS('font-size', '16px')
  await expect(resourceCode).toHaveCSS('font-family', /JetBrains Mono/)

  await page.evaluate((fonts) => window.browserPaneHarness.setFonts(fonts), smallerCodeSettings)
  await expect(resourceCode).toHaveCSS('font-size', '12px')
  await expect(resourceUi).toHaveCSS('font-size', '24px')
  await expect(resourceContent).toHaveCSS('font-size', '18px')
  await page.evaluate(() => window.browserPaneHarness.resetFonts())
  await expect(resourceContent).toHaveCSS('font-size', '14px')
})

for (const [pane, title, description] of [
  ['layout-editor', 'Choose a file to edit', 'Select a file from the Files panel.'],
  ['layout-terminal', 'Terminal unavailable', 'Connect an available runtime to use terminals.'],
  ['layout-terminal-available', 'Open a terminal', 'Open a terminal in the selected session.'],
] as const) {
  test(`shared empty state gives ${pane} actionable guidance`, async ({ page }) => {
    await page.route('**' + BROWSER_PANE_HARNESS_PATH + '**', (route) =>
      route.fulfill({ contentType: 'text/html', body: browserPaneHarnessHtml() })
    )
    await page.goto(`${BROWSER_PANE_HARNESS_PATH}?pane=${pane}`)
    await page.addScriptTag({ type: 'module', content: browserPaneHarnessModuleSource() })
    const empty = page.locator('[data-slot="empty"]')
    await expect(empty).toBeVisible()
    await expect(empty.getByRole('heading', { name: title, level: 2 })).toBeVisible()
    await expect(empty.locator('[data-slot="empty-description"]')).toHaveText(description)
    await expect(page.getByText('dev runtime status')).toHaveCount(0)
  })
}
