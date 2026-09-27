import { expect, test } from '@playwright/test'

import {
  BROWSER_PANE_HARNESS_PATH,
  browserPaneHarnessHtml,
  browserPaneHarnessModuleSource,
} from './helpers/dev-browser-pane-harness'

test.use({ headless: true })

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
