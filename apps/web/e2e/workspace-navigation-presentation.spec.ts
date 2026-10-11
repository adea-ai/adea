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
  await expect(
    page.getByRole('button', { name: 'Expand utility sidebar', exact: true })
  ).toBeVisible()
  await expect(page.getByLabel('Shared developer utilities')).toHaveCount(0)

  await page.getByRole('button', { name: 'Expand utility sidebar', exact: true }).click()
  const utilityHost = page.getByLabel('Shared developer utilities')
  await expect(utilityHost).toBeVisible()
  await expect(utilityHost).toHaveClass(/dev-utility--size-448/)
  await expect(
    page.getByText(
      'Browser utilities are unavailable until this view is bound to a canonical runtime session.'
    )
  ).toBeVisible()
  expect((await report()).runtimeCalls).not.toContain('dev.browser.lanes')
  await page.getByRole('button', { name: 'Devices', exact: true }).click()
  await expect(page.getByText('Scope-only simulator')).toBeVisible()
  await expect(
    page.getByText(
      'Start and stop actions are unavailable until this view is bound to a canonical runtime session.'
    )
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
    .poll(
      async () => (await report()).runtimeCalls.filter((call) => call === 'dev.device.list').length
    )
    .toBeGreaterThanOrEqual(2)
  expect((await report()).utility.runtimeSessionId).toBeUndefined()
  expect((await report()).runtimeCalls).not.toContain('dev.device.sessions')

  await utilityHost.getByRole('button', { name: 'Collapse utility sidebar', exact: true }).click()
  await expect(utilityHost).toHaveCount(0)
  const utilityOpener = page.getByRole('button', { name: 'Expand utility sidebar', exact: true })
  await expect(utilityOpener).toBeFocused()
  await utilityOpener.click()
  await expect(utilityHost).toBeVisible()
  await expect(page.getByRole('button', { name: 'Devices', exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  )
})

test('Chat and Virtual sidebars share the archive footer and restore with the listed scope and generation', async ({
  page,
}) => {
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
  const workspaceScope = {
    accountId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    runtimeNodeId: '00000000-0000-4000-8000-000000000003',
  }

  await page.evaluate(() => window.workspaceNavigationPresentationHarness.showChat())
  const chatSidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  const archiveAction = chatSidebar.getByRole('button', { name: /Archived sessions/ })
  await expect(archiveAction).toBeVisible()
  await archiveAction.click()
  const archivedRow = chatSidebar
    .getByRole('list', { name: 'Archived sessions', exact: true })
    .getByRole('listitem')
    .filter({ hasText: 'Archived cross-view session' })
  await expect(archivedRow).toBeVisible()

  const listCommand = (await report()).devCommands.find(
    (command) => command.operation === 'dev.session.list'
  )
  expect(listCommand).toMatchObject({
    scope: workspaceScope,
    body: { archived: true, limit: 500 },
  })

  await archivedRow.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(archivedRow).toHaveCount(0)
  await expect
    .poll(async () =>
      (await report()).devCommands.some((command) => command.operation === 'dev.session.unarchive')
    )
    .toBe(true)
  const commands = (await report()).devCommands
  const getCommand = commands.find((command) => command.operation === 'dev.session.get')
  const unarchiveCommand = commands.find((command) => command.operation === 'dev.session.unarchive')
  expect(getCommand).toMatchObject({
    scope: workspaceScope,
    body: { runtimeSessionId: 'archived-e2e-session' },
    resource: { kind: 'runtime_session', id: 'archived-e2e-session', generation: 7 },
  })
  expect(unarchiveCommand).toMatchObject({
    scope: workspaceScope,
    body: { runtimeSessionId: 'archived-e2e-session', expectedGeneration: 7 },
    resource: { kind: 'runtime_session', id: 'archived-e2e-session', generation: 7 },
  })

  await page.evaluate(() => window.workspaceNavigationPresentationHarness.showVirtual())
  const virtualSidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  const virtualArchiveAction = virtualSidebar.getByRole('button', { name: /Archived sessions/ })
  await expect(virtualArchiveAction).toBeVisible()
  await virtualArchiveAction.click()
  const virtualArchivedRow = virtualSidebar
    .getByRole('list', { name: 'Archived sessions', exact: true })
    .getByRole('listitem')
    .filter({ hasText: 'Archived cross-view session' })
  await expect(virtualArchivedRow).toBeVisible()
  expect((await report()).utility.runtimeSessionId).toBeUndefined()
  await virtualArchivedRow.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(virtualArchivedRow).toHaveCount(0)
  await expect
    .poll(async () =>
      (await report()).devCommands.filter(
        (command) => command.operation === 'dev.session.unarchive'
      )
    )
    .toHaveLength(2)
  const virtualRestore = (await report()).devCommands
    .filter((command) => command.operation === 'dev.session.unarchive')
    .at(-1)
  expect(virtualRestore).toMatchObject({
    scope: workspaceScope,
    body: { runtimeSessionId: 'archived-e2e-session', expectedGeneration: 7 },
    resource: { kind: 'runtime_session', id: 'archived-e2e-session', generation: 7 },
  })
})

test('discards a pending Chat archive page after switching to Virtual', async ({ page }) => {
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

  await page.evaluate(() => window.workspaceNavigationPresentationHarness.delayNextArchiveList())
  await page.evaluate(() => window.workspaceNavigationPresentationHarness.showChat())
  await expect.poll(async () => (await report()).pendingArchiveList).toBe(true)
  await page.evaluate(() => window.workspaceNavigationPresentationHarness.showVirtual())

  const virtualSidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  const archiveAction = virtualSidebar.getByRole('button', { name: /Archived sessions/ })
  await expect(archiveAction).toBeVisible()
  await archiveAction.click()
  const virtualRow = virtualSidebar
    .getByRole('list', { name: 'Archived sessions', exact: true })
    .getByRole('listitem')
    .filter({ hasText: 'Archived cross-view session' })
  await expect(virtualRow).toBeVisible()

  await page.evaluate(() => window.workspaceNavigationPresentationHarness.releaseArchiveList())
  await expect.poll(async () => (await report()).pendingArchiveList).toBe(false)
  await expect(virtualRow).toBeVisible()
  await expect(page.getByText('Stale Chat archive result')).toHaveCount(0)
  expect((await report()).utility.view).toBe('virtual')
})
