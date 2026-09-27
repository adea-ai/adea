import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('runtime transcript rows retain focused question identity and reset scoped drafts', async ({
  page,
}) => {
  const path = '/__chat-transcript-composition'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  const entry = resolve(
    process.cwd(),
    'apps/web/e2e/helpers/chat-transcript-composition-harness-app.tsx'
  )
  await page.addScriptTag({ type: 'module', content: `import '${'/@fs' + entry}'` })
  const question = page.getByRole('textbox', { name: 'Answer question' })
  await question.fill('Unfinished answer')
  const element = await question.elementHandle()
  await page.evaluate(() => window.chatTranscriptCompositionHarness.prepend())
  await expect(page.getByText('Opaque tool result')).toBeVisible()
  await expect(question).toBeFocused()
  await expect(question).toHaveValue('Unfinished answer')
  expect(await element!.evaluate((node) => node.isConnected)).toBe(true)
  await expect(page.getByRole('button', { name: 'Submit answer' })).toBeDisabled()
  await expect(page.getByRole('button', { name: /worked|collapse|expand/i })).toHaveCount(0)
  await page.evaluate(() => window.chatTranscriptCompositionHarness.reset())
  await expect(question).toHaveValue('')
})
