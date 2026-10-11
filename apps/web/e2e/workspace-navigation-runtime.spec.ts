import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const path = '/__workspace-navigation-runtime-harness'
const harness = resolve(
  process.cwd(),
  'apps/web/e2e/helpers/workspace-navigation-runtime-harness-app.tsx'
)

async function mountRuntimeNavigation(page: Page) {
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><head></head><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  await page.evaluate(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'chat')
    url.searchParams.set('runtime', 'ready')
    url.searchParams.set('devE2e', 'preserved')
    window.history.replaceState(null, '', url)
  })
  await page.addScriptTag({ type: 'module', content: `import '${'/@fs' + harness}'` })
}

test('actual Desktop Chat selection fences shared utility reads and browser actions', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  await mountRuntimeNavigation(page)

  const runtimeCalls = () =>
    page.evaluate(() => window.workspaceNavigationRuntimeHarness.report())
  const chatSession = (name: string) => page.getByRole('button', { name: new RegExp(name) })
  await expect(chatSession('First canonical session')).toBeVisible()

  await page.getByRole('button', { name: 'Expand utility sidebar', exact: true }).click()
  const sidebar = page.getByRole('complementary', { name: 'Developer utilities (right)' })
  await expect(sidebar).toBeVisible()
  await expect(sidebar.getByText('Page for fixture-shell')).toBeVisible()

  await page.evaluate(() =>
    window.workspaceNavigationRuntimeHarness.delayNext('dev.browser.takeover', 'fixture-shell')
  )
  await sidebar.getByRole('button', { name: 'Take over', exact: true }).click()
  await expect
    .poll(async () =>
      (await runtimeCalls()).some(
        (call) => call.operation === 'dev.browser.takeover' && call.sessionId === 'fixture-shell'
      )
    )
    .toBe(true)

  await page.evaluate(() =>
    window.workspaceNavigationRuntimeHarness.delayNext('dev.browser.lanes', 'fixture-runtime')
  )
  await chatSession('Second canonical session').click()
  await expect
    .poll(async () =>
      (await runtimeCalls()).some(
        (call) => call.operation === 'dev.browser.lanes' && call.sessionId === 'fixture-runtime'
      )
    )
    .toBe(true)
  await expect(sidebar.getByText('Page for fixture-shell')).toHaveCount(0)
  await expect(sidebar.getByText('No active lane')).toBeVisible()
  await expect(sidebar.getByRole('button', { name: 'Take over', exact: true })).toBeDisabled()
  await expect(sidebar.getByRole('button', { name: 'Screenshot', exact: true })).toBeDisabled()

  await page.evaluate(() =>
    window.workspaceNavigationRuntimeHarness.resolveDelayed('dev.browser.lanes', 'fixture-runtime')
  )
  await expect(sidebar.getByText('Page for fixture-runtime')).toBeVisible()
  const secondSessionLaneReads = (await runtimeCalls()).filter(
    (call) => call.operation === 'dev.browser.lanes' && call.sessionId === 'fixture-runtime'
  ).length
  expect(secondSessionLaneReads).toBe(1)

  await page.evaluate(() =>
    window.workspaceNavigationRuntimeHarness.resolveDelayed('dev.browser.takeover', 'fixture-shell')
  )
  await expect(sidebar.getByText('Page for fixture-runtime')).toBeVisible()
  await expect
    .poll(async () =>
      (await runtimeCalls()).filter(
        (call) => call.operation === 'dev.browser.lanes' && call.sessionId === 'fixture-runtime'
      ).length
    )
    .toBe(secondSessionLaneReads)
  await expect(page.getByRole('alert')).toHaveCount(0)

  await sidebar.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(sidebar.getByText('Agent fixture-runtime')).toBeVisible()
  await page.evaluate(() =>
    window.workspaceNavigationRuntimeHarness.delayNext('dev.harness.runs', 'fixture-shell', 2)
  )
  await page.evaluate(() =>
    window.workspaceNavigationRuntimeHarness.setPanePreference('fixture-shell', 'agents')
  )
  await chatSession('First canonical session').click()
  await expect
    .poll(async () =>
      (await runtimeCalls()).filter(
        (call) => call.operation === 'dev.harness.runs' && call.sessionId === 'fixture-shell'
      ).length
    )
    .toBeGreaterThan(0)
  await expect(sidebar.getByText('Agent fixture-runtime')).toHaveCount(0)
  await expect(sidebar.getByText('Agent fixture-shell')).toHaveCount(0)
  await page.evaluate(() =>
    window.workspaceNavigationRuntimeHarness.resolveDelayed('dev.harness.runs', 'fixture-shell')
  )
  await expect(sidebar.getByText('Agent fixture-shell')).toBeVisible()

  await sidebar.getByRole('button', { name: 'History', exact: true }).click()
  await expect(sidebar.getByText('model-fixture-shell')).toBeVisible()
  await page.evaluate(() =>
    window.workspaceNavigationRuntimeHarness.delayNext('dev.harness.runs', 'fixture-runtime')
  )
  await page.evaluate(() =>
    window.workspaceNavigationRuntimeHarness.setPanePreference('fixture-runtime', 'history')
  )
  await chatSession('Second canonical session').click()
  await expect
    .poll(async () =>
      (await runtimeCalls()).some(
        (call) => call.operation === 'dev.harness.runs' && call.sessionId === 'fixture-runtime'
      )
    )
    .toBe(true)
  await expect(sidebar.getByText('model-fixture-shell')).toHaveCount(0)
  await expect(sidebar.getByText('model-fixture-runtime')).toHaveCount(0)
  await page.evaluate(() =>
    window.workspaceNavigationRuntimeHarness.resolveDelayed('dev.harness.runs', 'fixture-runtime')
  )
  await expect(sidebar.getByText('model-fixture-runtime')).toBeVisible()
  expect(pageErrors).toEqual([])
})
