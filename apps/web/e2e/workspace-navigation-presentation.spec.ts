import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

const path = '/__workspace-navigation-presentation-harness'

test('production WorkspaceNavigation reports its resolved Dev selection and clears on view change', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><head></head><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  const app = resolve(
    process.cwd(),
    'apps/web/e2e/helpers/workspace-navigation-presentation-harness-app.tsx'
  )
  await page.addScriptTag({ type: 'module', content: `import '${'/@fs' + app}'` })

  const report = () => page.evaluate(() => window.workspaceNavigationPresentationHarness.report())
  const calls = async () => (await report()).calls
  const runtimeSession = page.getByRole('button', { name: /Runtime contracts/ })
  try {
    await expect(runtimeSession).toBeVisible()
  } catch (error) {
    throw new Error(
      `Production navigation failed to mount: ${pageErrors.join('\n') || 'no pageerror'}`,
      { cause: error }
    )
  }
  const notifications = page.getByRole('button', { name: 'Notifications', exact: true })
  await expect(notifications).toBeDisabled()
  await expect(notifications).toHaveAttribute(
    'aria-description',
    'Notifications are not available yet.'
  )
  await notifications.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Notifications are not available yet.')
  await notifications.focus()
  await notifications.press('Enter')
  await notifications.press('Space')
  const notificationBounds = await notifications.boundingBox()
  expect(notificationBounds).not.toBeNull()
  if (!notificationBounds) throw new Error('Notifications button has no visible bounds')
  await page.mouse.click(
    notificationBounds.x + notificationBounds.width / 2,
    notificationBounds.y + notificationBounds.height / 2
  )
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0)
  await expect
    .poll(async () => (await calls()).at(-1))
    .toEqual({ command: 'desktop_chat_presentation', sessionId: 'fixture-shell' })

  await runtimeSession.click()
  await expect
    .poll(async () => (await calls()).at(-1))
    .toEqual({ command: 'desktop_chat_presentation', sessionId: 'fixture-runtime' })

  await page.evaluate(() => window.workspaceNavigationPresentationHarness.showChat())
  await expect
    .poll(async () => (await calls()).at(-1))
    .toEqual({ command: 'desktop_chat_presentation', sessionId: null })

  const recorded = await calls()
  expect(recorded.every((call) => call.command === 'desktop_chat_presentation')).toBe(true)
  expect(
    recorded.every((call) => Object.keys(call).toSorted().join(',') === 'command,sessionId')
  ).toBe(true)
  expect(pageErrors).toEqual([])
})

test('WorkspaceNavigation invalidates the shared utility identity on Chat and Virtual view switches', async ({
  page,
}) => {
  const path = '/__workspace-navigation-presentation-harness'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><head></head><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  const app = resolve(
    process.cwd(),
    'apps/web/e2e/helpers/workspace-navigation-presentation-harness-app.tsx'
  )
  await page.addScriptTag({ type: 'module', content: `import '${'/@fs' + app}'` })
  const report = () => page.evaluate(() => window.workspaceNavigationPresentationHarness.report())

  await expect.poll(async () => (await report()).utility.view).toBe('dev')
  expect((await report()).utility.runtimeSessionId).toBeUndefined()
  await page.evaluate(() => window.workspaceNavigationPresentationHarness.showChat())
  await expect.poll(async () => (await report()).utility.view).toBe('chat')
  expect((await report()).utility.runtimeSessionId).toBeUndefined()

  await page.evaluate(() => window.workspaceNavigationPresentationHarness.showVirtual())
  await expect.poll(async () => (await report()).utility.view).toBe('virtual')
  expect((await report()).utility.runtimeSessionId).toBeUndefined()
})

test('WorkspaceNavigation lazily mounts scoped utilities across sessionless Chat and Virtual views', async ({
  page,
}) => {
  const path = '/__workspace-navigation-presentation-harness'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><head></head><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  const app = resolve(
    process.cwd(),
    'apps/web/e2e/helpers/workspace-navigation-presentation-harness-app.tsx'
  )
  await page.addScriptTag({ type: 'module', content: `import '${'/@fs' + app}'` })
  const report = () => page.evaluate(() => window.workspaceNavigationPresentationHarness.report())

  await page.evaluate(() => window.workspaceNavigationPresentationHarness.showChat())
  await expect.poll(async () => (await report()).utility.view).toBe('chat')
  await expect(page.getByRole('button', { name: 'Expand utility sidebar', exact: true })).toBeVisible()
  await expect(page.getByLabel('Shared developer utilities')).toHaveCount(0)

  await page.getByRole('button', { name: 'Expand utility sidebar', exact: true }).click()
  await expect(page.getByLabel('Shared developer utilities')).toBeVisible()
  await page.getByRole('button', { name: 'Devices', exact: true }).click()
  await expect(page.getByText('Scope-only simulator')).toBeVisible()
  await expect(
    page.getByText('Start and stop actions are unavailable until this view is bound to a canonical runtime session.')
  ).toBeVisible()
  await expect
    .poll(async () => (await report()).runtimeCalls.includes('dev.device.list'))
    .toBe(true)
  expect((await report()).runtimeCalls).not.toContain('dev.device.sessions')

  await page.evaluate(() => window.workspaceNavigationPresentationHarness.showVirtual())
  await expect.poll(async () => (await report()).utility.view).toBe('virtual')
  await expect(page.getByLabel('Shared developer utilities')).toBeVisible()
  await expect(page.getByText('Scope-only simulator')).toBeVisible()
  await expect
    .poll(async () => (await report()).runtimeCalls.filter((call) => call === 'dev.device.list').length)
    .toBeGreaterThanOrEqual(2)
  expect((await report()).utility.runtimeSessionId).toBeUndefined()
  expect((await report()).runtimeCalls).not.toContain('dev.device.sessions')
})
