import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const path = '/__workspace-navigation-presentation-harness'
const harness = resolve(
  process.cwd(),
  'apps/web/e2e/helpers/workspace-navigation-presentation-harness-app.tsx'
)

async function mountNavigation(page: Page, initialView: 'chat' | 'dev' | 'virtual') {
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><head></head><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  await page.evaluate((view) => {
    const url = new URL(window.location.href)
    url.searchParams.set('view', view)
    window.history.replaceState(null, '', url)
  }, initialView)
  await page.addScriptTag({ type: 'module', content: `import '${'/@fs' + harness}'` })
}

test('production WorkspaceNavigation reports its resolved Dev selection and clears on view change', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  await mountNavigation(page, 'dev')

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

test('direct Chat entry can open and collapse the shell utility sidebar without losing focus', async ({
  page,
}) => {
  await mountNavigation(page, 'chat')
  await expect(page.getByRole('button', { name: 'Chat view', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )

  const expand = page.getByRole('button', { name: 'Expand utility sidebar', exact: true })
  await expect(expand).toBeVisible()
  await expand.click()
  const collapse = page.getByRole('button', { name: 'Collapse utility sidebar', exact: true })
  await expect(collapse).toBeFocused()
  await expect(collapse).toHaveAttribute('aria-expanded', 'true')
  const sidebar = page.getByRole('complementary', { name: 'Developer utilities (right)' })
  await expect(sidebar).toBeVisible()

  await sidebar.getByRole('button', { name: 'Collapse right utility slot' }).click()
  const expandAgain = page.getByRole('button', { name: 'Expand utility sidebar', exact: true })
  await expect(expandAgain).toBeFocused()
  await expect(expandAgain).toHaveAttribute('aria-expanded', 'false')
  await expect(sidebar).toHaveCount(0)

  await expandAgain.click()
  const reopen = page.getByRole('button', { name: 'Collapse utility sidebar', exact: true })
  await expect(reopen).toBeFocused()
  await expect(reopen).toHaveAttribute('aria-expanded', 'true')
  await reopen.click()
  const collapsed = page.getByRole('button', { name: 'Expand utility sidebar', exact: true })
  await expect(collapsed).toBeFocused()
  await expect(collapsed).toHaveAttribute('aria-expanded', 'false')
  await expect(sidebar).toHaveCount(0)
})

test('Chat defers the utility owner until first open and retains it across view switches', async ({
  page,
}) => {
  await mountNavigation(page, 'chat')
  const expand = page.getByRole('button', { name: 'Expand utility sidebar', exact: true })
  await expect(expand).toBeVisible()
  await expect(
    page.getByRole('complementary', { name: 'Developer utilities (right)' })
  ).toHaveCount(0)
  expect(
    await page.evaluate(() =>
      window.workspaceNavigationPresentationHarness.utilityPreferenceReadCount()
    )
  ).toBe(0)

  await expand.click()
  const sidebar = page.getByRole('complementary', { name: 'Developer utilities (right)' })
  await expect(sidebar).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workspaceNavigationPresentationHarness.utilityPreferenceReadCount()
      )
    )
    .toBeGreaterThan(0)
  const ownerPreferenceReads = await page.evaluate(() =>
    window.workspaceNavigationPresentationHarness.utilityPreferenceReadCount()
  )

  await page.evaluate(() => window.workspaceNavigationPresentationHarness.showView('virtual'))
  await expect(page.getByRole('button', { name: 'Virtual view', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(sidebar).toBeVisible()
  await page.evaluate(() => window.workspaceNavigationPresentationHarness.showView('chat'))
  await expect(page.getByRole('button', { name: 'Chat view', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(sidebar).toBeVisible()
  expect(
    await page.evaluate(() =>
      window.workspaceNavigationPresentationHarness.utilityPreferenceReadCount()
    )
  ).toBe(ownerPreferenceReads)
})

test('direct Virtual entry opens an unavailable but truthful utility sidebar', async ({ page }) => {
  await mountNavigation(page, 'virtual')
  await expect(page.getByRole('button', { name: 'Virtual view', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )

  const expand = page.getByRole('button', { name: 'Expand utility sidebar', exact: true })
  await expand.click()
  const sidebar = page.getByRole('complementary', { name: 'Developer utilities (right)' })
  await expect(sidebar).toBeVisible()
  await expect(
    page.getByText(
      'Browser is unavailable because the Dev Runtime channel is channel_unauthenticated.'
    )
  ).toBeVisible()
  await expect(page.locator('#dev-center')).toHaveCount(0)

  await sidebar.getByRole('button', { name: 'Collapse right utility slot' }).click()
  const collapsed = page.getByRole('button', { name: 'Expand utility sidebar', exact: true })
  await expect(collapsed).toBeFocused()
  await expect(collapsed).toHaveAttribute('aria-expanded', 'false')
  await expect(sidebar).toHaveCount(0)

  await collapsed.click()
  await expect(page.locator('#dev-center')).toHaveCount(0)
  await expect(sidebar).toBeVisible()
  await expect(
    page.getByText(
      'Browser is unavailable because the Dev Runtime channel is channel_unauthenticated.'
    )
  ).toBeVisible()
})

test('the cross-view toggle exposes and restores the sidebar through Dev focus mode', async ({
  page,
}) => {
  await mountNavigation(page, 'dev')
  await page.getByRole('button', { name: 'Expand utility sidebar', exact: true }).click()
  const sidebar = page.getByRole('complementary', { name: 'Developer utilities (right)' })
  await sidebar.getByRole('button', { name: 'History', exact: true }).click()
  await expect(sidebar.getByRole('heading', { name: 'History', exact: true })).toBeVisible()

  await page.keyboard.press('ControlOrMeta+Shift+F')
  await expect(page.locator('.dev-workspace--focus')).toBeVisible()
  await expect(sidebar).toBeHidden()
  const expand = page.getByRole('button', { name: 'Expand utility sidebar', exact: true })
  await expect(expand).toHaveAttribute('aria-expanded', 'false')
  await expand.focus()
  await page.keyboard.press('Enter')

  const collapse = page.getByRole('button', { name: 'Collapse utility sidebar', exact: true })
  await expect(collapse).toBeFocused()
  await expect(collapse).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.dev-workspace--focus')).toHaveCount(0)
  await expect(sidebar).toBeVisible()
  await expect(sidebar.getByRole('heading', { name: 'History', exact: true })).toBeVisible()
})

test('one shell owner preserves pane, open state, and width through Dev, Chat, and Virtual', async ({
  page,
}) => {
  await mountNavigation(page, 'dev')
  await expect(page.locator('#dev-center')).toBeVisible()
  await page.getByRole('button', { name: 'Expand utility sidebar', exact: true }).click()

  const sidebar = page.getByRole('complementary', { name: 'Developer utilities (right)' })
  await expect(sidebar).toBeVisible()
  await sidebar.getByRole('button', { name: 'History', exact: true }).click()
  await expect(sidebar.getByRole('heading', { name: 'History', exact: true })).toBeVisible()
  const resize = page.getByRole('separator', { name: 'Resize right utility pane' })
  await expect(resize).toBeVisible()
  await resize.focus()
  const originalSize = Number(await resize.getAttribute('aria-valuenow'))
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(async () => Number(await resize.getAttribute('aria-valuenow')))
    .not.toBe(originalSize)
  const selectedSize = Number(await resize.getAttribute('aria-valuenow'))

  await page.getByRole('button', { name: 'Chat view', exact: true }).click()
  await expect(page.locator('#dev-center')).toHaveCount(0)
  await expect(sidebar).toBeVisible()
  await expect(sidebar.getByRole('heading', { name: 'History', exact: true })).toBeVisible()
  await expect(page.getByRole('separator', { name: 'Resize right utility pane' })).toHaveAttribute(
    'aria-valuenow',
    String(selectedSize)
  )

  await page.getByRole('button', { name: 'Virtual view', exact: true }).click()
  await expect(page.locator('#dev-center')).toHaveCount(0)
  await expect(sidebar).toBeVisible()
  await expect(sidebar.getByRole('heading', { name: 'History', exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Collapse utility sidebar', exact: true })
  ).toHaveAttribute('aria-expanded', 'true')

  await page.getByRole('button', { name: 'Dev view', exact: true }).click()
  await expect(page.locator('#dev-center')).toBeVisible()
  await expect(sidebar).toBeVisible()
  await expect(sidebar.getByRole('heading', { name: 'History', exact: true })).toBeVisible()
  await expect(page.getByRole('separator', { name: 'Resize right utility pane' })).toHaveAttribute(
    'aria-valuenow',
    String(selectedSize)
  )
})
