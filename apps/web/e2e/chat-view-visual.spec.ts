// Chat surface visual gate (#536 evidence lane).
//
// Baselines are committed per platform, exactly like the workspace visual
// gate (`conventional-workspace.spec.ts`): `-darwin` snapshots for the
// hardware-backed workstation lane (`bun run test:e2e:visual:chat` on macOS)
// and `-linux` snapshots for the `Workspace visual lane` workflow, which runs
// inside the pinned Playwright container so rendering stays reproducible.
// The captures render the development-only ChatView fixture
// (`/?view=chat&chatE2e=visual`), so no database or runtime is needed — only
// the bootstrap request is mocked.
import { expect, test, type Page } from './helpers/visual'

const workspace = {
  id: 'workspace-chat-visual-e2e',
  name: 'Chat Visual Evidence',
  scene: 'work',
  updatedAt: '2026-09-22T10:00:00.000Z',
}

const viewports = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
] as const

const themes = ['light', 'dark'] as const
const states = ['conversation', 'attention', 'reconnect'] as const

type Theme = (typeof themes)[number]

async function applyTheme(page: Page, theme: Theme) {
  await page.emulateMedia({ colorScheme: theme })
  await page.addInitScript((selected: Theme) => {
    localStorage.clear()
    localStorage.setItem('theme', selected)
  }, theme)
}

async function forceResolvedTheme(page: Page, theme: Theme) {
  // The ThemeProvider resolves the stored preference on boot; pin the resolved
  // classes on the document element so a capture can never race the
  // application of the stored preference.
  await page.evaluate((selected: Theme) => {
    document.documentElement.classList.toggle('dark', selected === 'dark')
    document.documentElement.classList.toggle('light', selected === 'light')
  }, theme)
}

for (const state of states) {
  for (const theme of themes) {
    for (const viewport of viewports) {
      test(`ChatView ${state} ${theme} ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await applyTheme(page, theme)
        await page.route('**/api/workspaces/bootstrap', (route) =>
          route.fulfill({
            contentType: 'application/json',
            json: {
              activeWorkspace: workspace,
              principal: { temporary: true, userId: 'chat-visual-user' },
              workspaces: [workspace],
            },
          })
        )

        await page.goto(`/?view=chat&chatE2e=visual&chatState=${state}`)
        const fixture = page.locator('[data-chat-visual-state]')
        await expect(fixture).toBeVisible({ timeout: 30_000 })
        await expect(fixture).toHaveAttribute('data-chat-visual-state', state)
        await expect(page.locator('section.dev-chat')).toBeVisible()
        await forceResolvedTheme(page, theme)

        if (state === 'conversation') {
          await expect(page.getByRole('article')).toHaveCount(5)
          await expect(page.getByText('The plan is ready.', { exact: false }).first()).toBeVisible()
          await expect(page.getByRole('textbox', { name: 'Message runtime' })).toBeEnabled()
        } else if (state === 'attention') {
          await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible()
          await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible()
          await expect(page.getByRole('button', { name: 'Submit answer' })).toBeDisabled()
          await expect(page.getByRole('textbox', { name: 'Message runtime' })).toBeDisabled()
          await expect(page.locator('#dev-chat-composer-status')).toContainText('approval')
        } else {
          await expect(
            page.getByRole('alert').filter({ hasText: 'Transcript gap detected' })
          ).toBeVisible()
          await expect(page.getByRole('button', { name: 'Reconnect transcript' })).toBeVisible()
          await expect(page.locator('.dev-chat__status')).toContainText('Disconnected')
        }

        await expect(page).toHaveScreenshot(`chat-view-${state}-${theme}-${viewport.name}.png`, {
          animations: 'disabled',
          fullPage: true,
        })
      })
    }
  }
}

test('ChatView keeps an existing transcript row mounted when a stream event is appended', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await applyTheme(page, 'light')
  await page.route('**/api/workspaces/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        activeWorkspace: workspace,
        principal: { temporary: true, userId: 'chat-visual-user' },
        workspaces: [workspace],
      },
    })
  )

  await page.goto('/?view=chat&chatE2e=visual&chatState=streaming')
  await expect(page.locator('[data-chat-visual-state="streaming"]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('article')).toHaveCount(5)
  const firstRow = await page.getByRole('article').first().elementHandle()
  expect(firstRow).not.toBeNull()

  // The fixture appends exactly when the spec dispatches its window event,
  // so the mount-stability check never races a wall clock.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:append')))
  await expect(page.getByRole('article')).toHaveCount(6, { timeout: 5_000 })
  const firstRowRemainedMounted = await firstRow?.evaluate(
    (node) => node.isConnected && node === document.querySelector('article.dev-chat__row')
  )
  expect(firstRowRemainedMounted).toBe(true)
})
