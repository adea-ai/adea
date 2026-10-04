import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

async function mount(page: import('@playwright/test').Page) {
  const path = '/__desktop-runtime-chat'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><head><style>html,body,#harness-root{margin:0;height:100%;}</style></head><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  const entry = resolve(process.cwd(), 'apps/web/e2e/helpers/desktop-runtime-chat-harness-app.tsx')
  await page.evaluate(async (moduleUrl) => {
    await import(/* @vite-ignore */ moduleUrl)
  }, '/@fs' + entry)
  await expect(page.getByRole('heading', { name: 'First canonical session' })).toBeVisible()
}

test('returning production Chat does not imply that Control Plane selection is wired', async ({
  page,
}) => {
  await mount(page)

  await expect(page.getByLabel('Mode')).toHaveCount(0)
  await expect(page.getByText('Agent', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Resolve & launch' })).toHaveCount(0)
  await expect(
    page.getByText('Customize pins are submitted to the Control Plane and remain authoritative.', {
      exact: true,
    })
  ).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message runtime' })).toBeVisible()
})

test('returning desktop Chat mounts canonical sessions and retains draft through Dev remount', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await mount(page)
  await expect(page.getByRole('complementary', { name: 'Projects and sessions' })).toBeVisible()
  const layout = await page.evaluate(() => ({
    viewport: window.innerHeight,
    chat: document.querySelector('.dev-chat')!.getBoundingClientRect().height,
    sidebar: document.querySelector('.dev-sidebar')!.getBoundingClientRect().height,
    background: getComputedStyle(document.querySelector('.dev-sidebar')!).backgroundColor,
  }))
  expect(layout.chat).toBeGreaterThanOrEqual(layout.viewport - 2)
  expect(layout.sidebar).toBeGreaterThanOrEqual(layout.viewport - 2)
  expect(layout.background).not.toBe('rgba(0, 0, 0, 0)')
  await page.evaluate(() => window.desktopRuntimeChatHarness.saveDraft('Scoped unfinished draft'))
  await page.evaluate(() => window.desktopRuntimeChatHarness.unmount())
  await expect(page.getByText('Dev surface', { exact: true })).toBeVisible()
  await page.evaluate(() => window.desktopRuntimeChatHarness.remount())
  await expect(page.getByRole('heading', { name: 'First canonical session' })).toBeVisible()
  const report = await page.evaluate(() => window.desktopRuntimeChatHarness.report())
  expect(report.draft).toBe('Scoped unfinished draft')
  expect(report.closes).toBeGreaterThan(0)
  expect(
    report.calls.every((operation) =>
      ['dev.project.list', 'dev.group.list', 'dev.session.list', 'dev.session.events'].includes(
        operation
      )
    )
  ).toBe(true)
  expect(errors).toEqual([])
})

test('late desktop Chat attach cannot replace a newer selected session', async ({ page }) => {
  await mount(page)
  await page.evaluate(() => {
    window.desktopRuntimeChatHarness.delayNextAttach()
    window.desktopRuntimeChatHarness.selectSecond()
  })
  await expect(page.getByText('Opening conversation…')).toBeVisible()
  await page.evaluate(() => window.desktopRuntimeChatHarness.selectFirst())
  await expect(page.getByRole('heading', { name: 'First canonical session' })).toBeVisible()
  await page.evaluate(() => window.desktopRuntimeChatHarness.resolveAttach())
  await expect(page.getByRole('heading', { name: 'First canonical session' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Second canonical session' })).toHaveCount(0)
})

test('refused returning Chat stays in canonical recovery and retries without launching', async ({
  page,
}) => {
  await mount(page)
  await page.evaluate(() => {
    window.desktopRuntimeChatHarness.refuseAttach(true)
    window.desktopRuntimeChatHarness.selectSecond()
  })
  await expect(
    page.getByText('This conversation is unavailable. Retry or select another session.')
  ).toBeVisible()
  await expect(page.getByText('Legacy team chat')).toHaveCount(0)
  await page.evaluate(() => window.desktopRuntimeChatHarness.refuseAttach(false))
  await page.getByRole('button', { name: 'Retry conversation' }).click()
  await expect(page.getByRole('heading', { name: 'Second canonical session' })).toBeVisible()
})

test('returning Chat reports only its mounted session and clears hints on pending attach and disposal', async ({
  page,
}) => {
  await mount(page)
  const firstId = '00000000-0000-4000-8000-000000000005'
  const secondId = '00000000-0000-4000-8000-000000000006'
  const currentHint = () =>
    page.evaluate(() => window.desktopRuntimeChatHarness.report().presentations.at(-1))
  await expect.poll(currentHint).toBe(firstId)
  await page.evaluate(() => {
    window.desktopRuntimeChatHarness.delayNextAttach()
    window.desktopRuntimeChatHarness.selectSecond()
  })
  await expect(page.getByText('Opening conversation…')).toBeVisible()
  await expect.poll(currentHint).toBe(null)
  await page.evaluate(() => window.desktopRuntimeChatHarness.selectFirst())
  await expect.poll(currentHint).toBe(firstId)
  await page.evaluate(() => window.desktopRuntimeChatHarness.resolveAttach())
  await expect(page.getByRole('heading', { name: 'First canonical session' })).toBeVisible()
  expect(
    await page.evaluate(() => window.desktopRuntimeChatHarness.report().presentations)
  ).not.toContain(secondId)
  await page.evaluate(() => window.desktopRuntimeChatHarness.unmount())
  await expect.poll(currentHint).toBe(null)
  await page.evaluate(() => window.desktopRuntimeChatHarness.remount())
  await expect.poll(currentHint).toBe(firstId)
})
