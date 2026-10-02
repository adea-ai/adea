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

  const calls = () => page.evaluate(() => window.workspaceNavigationPresentationHarness.report())
  const runtimeSession = page.getByRole('button', { name: /Runtime contracts/ })
  try {
    await expect(runtimeSession).toBeVisible()
  } catch (error) {
    throw new Error(
      `Production navigation failed to mount: ${pageErrors.join('\n') || 'no pageerror'}`,
      { cause: error }
    )
  }
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
