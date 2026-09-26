import { expect, test } from '@playwright/test'

import {
  DESKTOP_FIRST_RUN_CHAT_HARNESS_PATH,
  desktopFirstRunChatHarnessHtml,
  desktopFirstRunChatHarnessModuleSource,
} from './helpers/desktop-first-run-chat-harness'

test('ignores a deferred onboarding callback after the rendered scope is disposed', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('**' + DESKTOP_FIRST_RUN_CHAT_HARNESS_PATH, (route) =>
    route.fulfill({ contentType: 'text/html', body: desktopFirstRunChatHarnessHtml() })
  )
  await page.goto(DESKTOP_FIRST_RUN_CHAT_HARNESS_PATH)
  await page.addScriptTag({ type: 'module', content: desktopFirstRunChatHarnessModuleSource() })

  await expect(page.getByRole('heading', { name: 'Start a conversation' })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByLabel('Your first message').fill('old scope prompt')
  await page.getByRole('button', { name: 'Start conversation' }).click()

  await page.evaluate(() => window.desktopFirstRunChatHarness.replaceScope())
  await expect(page.getByTestId('disposed-fallback')).toBeVisible()
  expect(await page.evaluate(() => window.desktopFirstRunChatHarness.resolveOldCreate())).toBe(true)
  await page.evaluate(() => window.desktopFirstRunChatHarness.restoreNextScope())
  await expect(page.getByRole('heading', { name: 'Start a conversation' })).toBeVisible({
    timeout: 30_000,
  })

  await expect
    .poll(() => page.evaluate(() => window.desktopFirstRunChatHarness.report()))
    .toEqual({
      old: { attachCalls: 0, label: 'old' },
      next: { attachCalls: 0, label: 'next' },
      conversationCallbacks: 1,
      lateStateReadFailures: 0,
    })
  expect(pageErrors).toEqual([])
})
