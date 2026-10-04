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
  const text = page.locator('.dev-chat__text').filter({ hasText: 'Which target?' })
  const header = page.locator('.dev-chat__row-header').last()
  const originalHeaderSize = await header.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).fontSize)
  )
  await expect(text).toHaveCSS('font-size', '14px')
  const fontResponse = page.waitForResponse(
    (response) =>
      response.url().includes('geist') && response.url().includes('.woff') && response.ok()
  )
  await page.evaluate(() =>
    window.chatTranscriptCompositionHarness.setFonts({
      ui: { family: 'system', size: 28 },
      content: { family: 'geist', size: 18 },
      code: { family: 'system', size: 12 },
    })
  )
  await fontResponse
  await expect(text).toHaveCSS('font-family', /Geist/)
  await expect(text).toHaveCSS('font-size', '18px')
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.fonts].some(
          (font) => font.family.includes('Geist') && font.status === 'loaded'
        )
      )
    )
    .toBe(true)
  await expect
    .poll(() => header.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)))
    .toBeCloseTo(originalHeaderSize * 2)
  await expect(question).toHaveValue('Unfinished answer')
  expect(await element!.evaluate((node) => node.isConnected)).toBe(true)
  await page.evaluate(() => window.chatTranscriptCompositionHarness.resetFonts())
  await expect(text).toHaveCSS('font-size', '14px')
  await expect(text).not.toHaveCSS('font-family', /Geist/)
  await page.evaluate(() => window.chatTranscriptCompositionHarness.reset())
  await expect(question).toHaveValue('')
})
