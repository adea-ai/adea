import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

const path = '/__desktop-chat-presentation-harness'

test('reporter hook harness serializes Chat and Dev presentation hints', async ({ page }) => {
  const pageErrors: string[] = []
  const failedRequests: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('requestfailed', (request) =>
    failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`)
  )
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><head></head><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  const app = resolve(
    process.cwd(),
    'apps/web/e2e/helpers/desktop-chat-presentation-harness-app.tsx'
  )
  await page.addScriptTag({ type: 'module', content: `import '${'/@fs' + app}'` })
  try {
    await expect
      .poll(() => page.evaluate(() => Boolean(window.desktopChatPresentationHarness)))
      .toBe(true)
  } catch (error) {
    throw new Error(
      `Presentation harness failed to mount. page errors: ${pageErrors.join('; ') || 'none'}; failed requests: ${failedRequests.join('; ') || 'none'}`,
      { cause: error }
    )
  }

  const presentation = () =>
    page.evaluate(() => window.desktopChatPresentationHarness.report().at(-1) ?? null)
  await expect
    .poll(presentation)
    .toEqual({ command: 'desktop_chat_presentation', sessionId: 'dev-1' })

  await page.evaluate(() => window.desktopChatPresentationHarness.setChatSession('chat-1'))
  await expect
    .poll(presentation)
    .toEqual({ command: 'desktop_chat_presentation', sessionId: 'chat-1' })

  // A pending Chat attach clears its source and reveals the visible Dev selection.
  await page.evaluate(() => window.desktopChatPresentationHarness.setChatSession(undefined))
  await expect
    .poll(presentation)
    .toEqual({ command: 'desktop_chat_presentation', sessionId: 'dev-1' })

  // Disposing Chat clears only Chat; disposing Dev then clears the final hint.
  await page.evaluate(() => window.desktopChatPresentationHarness.setChatSession('chat-2'))
  await expect
    .poll(presentation)
    .toEqual({ command: 'desktop_chat_presentation', sessionId: 'chat-2' })
  await page.evaluate(() => window.desktopChatPresentationHarness.unmountChat())
  await expect
    .poll(presentation)
    .toEqual({ command: 'desktop_chat_presentation', sessionId: 'dev-1' })
  await page.evaluate(() => window.desktopChatPresentationHarness.unmountDev())
  await expect.poll(presentation).toEqual({ command: 'desktop_chat_presentation', sessionId: null })

  const calls = await page.evaluate(() => window.desktopChatPresentationHarness.report())
  expect(calls.every((call) => call.command === 'desktop_chat_presentation')).toBe(true)
  expect(
    calls.every((call) => Object.keys(call).toSorted().join(',') === 'command,sessionId')
  ).toBe(true)
  expect(pageErrors).toEqual([])
})
