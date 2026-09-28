import { expect, test, type Page } from '@playwright/test'

import {
  DEV_WORKSPACE_RUNTIME_TERMINAL_PATH,
  devWorkspaceRuntimeTerminalHtml,
  devWorkspaceRuntimeTerminalModuleSource,
} from './helpers/dev-workspace-runtime-terminal'

test.use({
  launchOptions: {
    args: ['--disable-webgl', '--disable-webgl2', '--disable-features=LocalNetworkAccessChecks'],
  },
})

declare global {
  interface Window {
    devWorkspaceRuntimeTerminalHarness: {
      report(): Promise<{
        commands: Array<{
          operation: string
          sessionId?: string
          worktreeId?: string
          terminalId?: string
          generation?: number
          direction?: string
        }>
        attachments: Array<{ terminalId: string; direction: string; generation: number }>
        primaryListHeld: boolean
      }>
      releasePrimaryList(): Promise<void>
      selectSession(runtimeSessionId: string): void
    }
  }
}

async function openHarness(page: Page, scenario: string) {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route(new RegExp(`${DEV_WORKSPACE_RUNTIME_TERMINAL_PATH}(?:\\?.*)?$`), (route) =>
    route.fulfill({ contentType: 'text/html', body: devWorkspaceRuntimeTerminalHtml() })
  )
  await page.goto(`${DEV_WORKSPACE_RUNTIME_TERMINAL_PATH}?scenario=${scenario}`)
  await page.addScriptTag({
    type: 'module',
    content: devWorkspaceRuntimeTerminalModuleSource(),
  })
  await expect
    .poll(() => page.evaluate(() => Boolean(window.devWorkspaceRuntimeTerminalHarness)), {
      timeout: 30_000,
    })
    .toBe(true)
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 30_000,
  })
}

async function report(page: Page) {
  return page.evaluate(() => window.devWorkspaceRuntimeTerminalHarness.report())
}

test('production entry binds the selected session terminal and retires a stale list result', async ({
  page,
}) => {
  await openHarness(page, 'race')
  await expect.poll(async () => (await report(page)).primaryListHeld).toBe(true)

  await page.getByRole('button', { name: /Other session$/ }).click()
  const pane = page.locator('[data-pane-id="dev-terminal"] .dev-terminal-pane')
  await expect(pane).toHaveAttribute('data-attach-from', '0', { timeout: 30_000 })
  await expect(pane.locator('.dev-terminal-pane-status')).toHaveAttribute('data-state', 'open')
  await expect(pane.locator('.xterm-rows')).toContainText('selected terminal 44444444')

  const beforeRelease = await report(page)
  expect(beforeRelease.commands.filter((item) => item.operation === 'dev.terminal.attach')).toEqual(
    [
      expect.objectContaining({
        sessionId: undefined,
        worktreeId: undefined,
        terminalId: '44444444-4444-4444-8444-444444444444',
        generation: 9,
        direction: 'read',
      }),
    ]
  )

  await page.evaluate(async () => window.devWorkspaceRuntimeTerminalHarness.releasePrimaryList())
  const afterRelease = await report(page)
  expect(
    afterRelease.commands
      .filter((item) => item.operation === 'dev.terminal.attach')
      .map((item) => item.terminalId)
  ).toEqual(['44444444-4444-4444-8444-444444444444'])
  expect(afterRelease.attachments.map((item) => item.terminalId)).toEqual([
    '44444444-4444-4444-8444-444444444444',
    '44444444-4444-4444-8444-444444444444',
  ])
})

test('stored explicit terminal leaves win; only the first unbound leaf uses the primary', async ({
  page,
}) => {
  await openHarness(page, 'explicit')
  const primaryLeaf = page.locator('[data-pane-id="primary-terminal"] .dev-terminal-pane')
  const explicitLeaf = page.locator('[data-pane-id="explicit-terminal"] .dev-terminal-pane')
  await expect(primaryLeaf.locator('.dev-terminal-pane-status')).toHaveAttribute(
    'data-state',
    'open',
    { timeout: 30_000 }
  )
  await expect(explicitLeaf.locator('.dev-terminal-pane-status')).toHaveAttribute(
    'data-state',
    'open'
  )
  const state = await report(page)
  expect(
    state.commands
      .filter((item) => item.operation === 'dev.terminal.attach')
      .map(({ terminalId, generation }) => [terminalId, generation])
      .toSorted(([left], [right]) => String(left).localeCompare(String(right)))
  ).toEqual([
    ['33333333-3333-4333-8333-333333333333', 7],
    ['55555555-5555-4555-8555-555555555555', 8],
  ])
})

test('later unbound terminal splits do not duplicate the primary terminal', async ({ page }) => {
  await openHarness(page, 'primary')
  await expect(
    page.locator('[data-pane-id="dev-terminal"] .dev-terminal-pane-status')
  ).toHaveAttribute('data-state', 'open', { timeout: 30_000 })
  const splitButton = page.getByRole('button', { name: 'Split pane', exact: true })
  await splitButton.click()
  await splitButton.click()

  await expect(
    page.getByText('No terminal is selected for this pane.', { exact: true })
  ).toBeVisible()
  const state = await report(page)
  expect(state.commands.filter((item) => item.operation === 'dev.terminal.list')).toHaveLength(1)
  expect(state.commands.filter((item) => item.operation === 'dev.terminal.attach')).toHaveLength(1)
  expect(state.attachments.map((item) => item.terminalId)).toEqual([
    '33333333-3333-4333-8333-333333333333',
    '33333333-3333-4333-8333-333333333333',
  ])
})

test('retry re-runs terminal verification without creating a terminal', async ({ page }) => {
  await openHarness(page, 'retry')
  await expect(
    page.getByText('The selected terminal is unavailable for this runtime.', { exact: true })
  ).toBeVisible()
  expect(
    (await report(page)).commands.filter((item) => item.operation === 'dev.terminal.list')
  ).toHaveLength(1)
  expect(
    (await report(page)).commands.filter((item) => item.operation === 'dev.terminal.create')
  ).toEqual([])

  await page.getByRole('button', { name: 'Retry terminal', exact: true }).click()
  await expect(
    page.locator('[data-pane-id="dev-terminal"] .dev-terminal-pane-status')
  ).toHaveAttribute('data-state', 'open', { timeout: 30_000 })
  const state = await report(page)
  expect(state.commands.filter((item) => item.operation === 'dev.terminal.list')).toHaveLength(2)
  expect(state.commands.filter((item) => item.operation === 'dev.terminal.create')).toEqual([])
  expect(state.commands.filter((item) => item.operation === 'dev.terminal.attach')).toHaveLength(1)
})

test('input denial prevents terminal listing, while missing manage disables resize', async ({
  page,
}) => {
  await openHarness(page, 'deny-input')
  await expect(
    page.getByText('Terminal input is unavailable for this runtime.', { exact: true })
  ).toBeVisible()
  expect(
    (await report(page)).commands.filter((item) => item.operation === 'dev.terminal.list')
  ).toEqual([])

  await page.goto(`${DEV_WORKSPACE_RUNTIME_TERMINAL_PATH}?scenario=no-manage`)
  await page.addScriptTag({
    type: 'module',
    content: devWorkspaceRuntimeTerminalModuleSource(),
  })
  await expect
    .poll(() => page.evaluate(() => Boolean(window.devWorkspaceRuntimeTerminalHarness)), {
      timeout: 30_000,
    })
    .toBe(true)
  const pane = page.locator('[data-pane-id="dev-terminal"] .dev-terminal-pane')
  await expect(pane.locator('.dev-terminal-pane-status')).toHaveAttribute('data-state', 'open', {
    timeout: 30_000,
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(250)
  expect(
    (await report(page)).commands.filter((item) => item.operation === 'dev.terminal.resize')
  ).toEqual([])
})
