import { expect, test, type Locator } from '@playwright/test'
import { resolve } from 'node:path'

async function mount(page: import('@playwright/test').Page) {
  const path = '/__desktop-start-surface'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><head><style>html,body,#harness-root{margin:0;height:100%;}</style></head><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  const entry = resolve(process.cwd(), 'apps/web/e2e/helpers/desktop-start-surface-harness-app.tsx')
  await page.evaluate(async (moduleUrl) => {
    await import(/* @vite-ignore */ moduleUrl)
  }, '/@fs' + entry)
  await expect(
    page.getByRole('heading', { name: 'Your workspace, ready when you are.' })
  ).toBeVisible()
}

/** The rendered paint of one action button, plus the document's resolved
 * `--primary` token for the filled-rung comparison. */
async function paintOf(button: Locator, page: import('@playwright/test').Page) {
  const paint = await button.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      borderStyle: style.borderBottomStyle,
      borderColor: style.borderBottomColor,
    }
  })
  const primaryPaint = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = 'var(--primary)'
    document.body.append(probe)
    const value = getComputedStyle(probe).backgroundColor
    probe.remove()
    return value
  })
  return { ...paint, primaryPaint }
}

test('the offline start surface keeps the outline sign-in beside the filled retry', async ({
  page,
}) => {
  await mount(page)

  // The failed bootstrap lands on the offline state: the filled retry action
  // and the outline sign-in action render side by side.
  const actions = page.locator('.auth-actions')
  const tryAgain = actions.getByRole('button', { name: 'Try again' })
  const signIn = actions.getByRole('button', { name: 'Sign in' })
  await expect(tryAgain).toBeVisible()
  await expect(signIn).toBeVisible()

  const retryPaint = await paintOf(tryAgain, page)
  const signInPaint = await paintOf(signIn, page)

  // The retry action is the filled primary rung.
  expect(retryPaint.background).toBe(retryPaint.primaryPaint)
  // The sign-in action keeps the outline variant: no fill, a real border.
  expect(signInPaint.background).toBe('rgba(0, 0, 0, 0)')
  expect(signInPaint.borderStyle).not.toBe('none')
  expect(signInPaint.borderColor).not.toBe('rgba(0, 0, 0, 0)')
})
