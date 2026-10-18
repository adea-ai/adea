// Actual built desktop UI; disposable API and bridge only. This checks app
// navigation/availability, not native authority or offline cloud execution.
import { chromium, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { serveDesktopClient } from '../apps/desktop/shell/src/client-assets'

const client = fileURLToPath(new URL('../apps/web/dist-desktop/client/', import.meta.url))
const workspace = {
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Local Sim qualification',
  scene: 'home',
  accent: null,
  logo: { kind: 'monogram' },
  sortOrder: 0,
  version: 1,
  updatedAt: '2026-10-17T00:00:00Z',
}
const credential = `adea_tmp_${'c'.repeat(43)}`
let grants = 0
const requests: string[] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    requests.push(path)
    if (path === '/api/workspaces/bootstrap')
      return Response.json({
        activeWorkspace: workspace,
        principal: { temporary: true, userId: '00000000-0000-4000-8000-000000000001' },
        temporaryCredential: credential,
        workspaces: [workspace],
      })
    if (path === '/api/workspaces') return Response.json([workspace])
    if (path === '/api/sim/config')
      return Response.json({ frameOrigin: 'https://sim-unavailable.invalid' })
    if (path === '/api/sim/launch') {
      grants++
      return Response.json({ status: 'unavailable', reason: 'service_unavailable' })
    }
    if (path === '/api/v1/account/summary') return Response.json({ workspaces: [] })
    if (path.startsWith('/api/v1/account/agents')) return Response.json({ agents: [] })
    if (path.startsWith('/api/v1/account/conversations'))
      return Response.json({ conversations: [] })
    if (path.endsWith('/events'))
      return new Response('', { headers: { 'content-type': 'text/event-stream' } })
    if (path.startsWith('/api/')) {
      if (path.endsWith('/read-state')) return Response.json({ readState: [] })
      if (
        ['/projects', '/agents', '/tasks', '/channels', '/artifacts'].some((suffix) =>
          path.endsWith(suffix)
        )
      )
        return Response.json([])
      return Response.json({})
    }
    return serveDesktopClient(request, client)
  },
})
const origin = server.url.origin
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.route('**/*', (route) =>
  new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
)
await context.addInitScript(() => {
  const win = window as unknown as { __adeaDesktop: unknown }
  win.__adeaDesktop = {
    invoke: async (command: string) => {
      if (command === 'adea_app_version') return 'local-fixture'
      if (
        command === 'desktop_user_session_load' ||
        command === 'desktop_auth_take_callback' ||
        command === 'desktop_temporary_workspace_load' ||
        command === 'desktop_temporary_workspace_save' ||
        command === 'local_content_authorize_workspace'
      )
        return null
      throw new Error('Local fixture supplies no native authority')
    },
    listen: async () => () => {},
  }
})
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
try {
  const rail = page.locator('[data-global-rail]')
  const library = page.getByRole('main', { name: 'App Library', exact: true })
  const views = rail.getByRole('group', { name: 'Workspace views' }).locator('[data-row-id]')
  const simRequests = () => requests.filter((path) => path.startsWith('/api/sim/'))
  await page.goto(origin)
  await expect(rail.getByRole('button', { name: 'Chat view', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(views).toHaveCount(2)
  await expect(views.nth(0)).toHaveAttribute('aria-label', 'Chat view')
  await expect(views.nth(1)).toHaveAttribute('aria-label', 'Dev view')
  await rail.getByRole('button', { name: 'Dev view', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 30_000,
  })
  await page.goto(`${origin}/?view=virtual&characterDesigner=1&roomDesigner=1`)
  await expect(page).toHaveURL(/view=chat/)
  await expect(page.locator('[data-agent-sim-hosted], iframe')).toHaveCount(0)
  expect(simRequests()).toEqual([])
  expect(
    requests.filter((path) =>
      /hosted-sim-entry|room-designer-entry|character-designer-entry/.test(path)
    )
  ).toEqual([])

  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  for (const name of ['Virtual', 'Kanban', 'Source control'])
    await library.getByRole('button', { name: `Enable ${name}`, exact: true }).click()
  await expect(views).toHaveCount(5)
  expect(simRequests()).toEqual([])
  await page.reload()
  await expect(library.getByRole('button', { name: 'Open Virtual', exact: true })).toBeVisible()
  await expect(views).toHaveCount(5)
  expect(simRequests()).toEqual([])
  for (const name of ['Virtual', 'Kanban', 'Source control'])
    await library.getByRole('button', { name: `Disable ${name}`, exact: true }).click()
  await page.goto(`${origin}/?view=virtual`)
  await expect(page).toHaveURL(/view=chat/)
  expect(simRequests()).toEqual([])

  // A real legacy record represents explicit existing choices, including
  // preserved unknown IDs and a deliberate hidden app; reading must not reset it.
  const legacy = {
    version: 1,
    order: ['virtual', 'dev', 'chat', 'kanban', 'source-control', 'app:future'],
    hidden: ['kanban', 'source-control', 'app:hidden'],
  }
  await page.evaluate((preferences) => {
    localStorage.setItem('adea:rail-preferences:v1', JSON.stringify(preferences))
  }, legacy)
  await page.reload()
  await expect(rail.getByRole('button', { name: 'Virtual view', exact: true })).toBeVisible()
  await expect(rail.getByRole('button', { name: 'Kanban', exact: true })).toHaveCount(0)
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('adea:rail-preferences:v1')!))
  ).toEqual(legacy)
  expect(simRequests()).toEqual([])
  await rail.getByRole('button', { name: 'Virtual view', exact: true }).click()
  await expect(page.getByText('Agent Sim is unavailable right now', { exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await rail.getByRole('button', { name: 'Chat view', exact: true }).click()
  await expect(page).toHaveURL(/view=chat/)
  await expect(page.locator('[data-agent-sim-hosted]')).toHaveCount(0)
  await rail.getByRole('button', { name: 'Dev view', exact: true }).click()
  await expect(page).toHaveURL(/view=dev/)
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 30_000,
  })
  await rail.getByRole('button', { name: 'Virtual view', exact: true }).click()
  await expect(page.getByText('Agent Sim is unavailable right now', { exact: true })).toBeVisible()
  const beforeOffline = grants
  await context.setOffline(true)
  await expect(page.getByText('Agent Sim is offline', { exact: true })).toBeVisible()
  await rail.getByRole('button', { name: 'Chat view', exact: true }).click()
  await expect(page).toHaveURL(/view=chat/)
  await rail.getByRole('button', { name: 'Dev view', exact: true }).click()
  await expect(page).toHaveURL(/view=dev/)
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible()
  expect(grants).toBe(beforeOffline)
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      evidence: 'actual built client with synthetic API/bridge; local only',
      freshChatDevOnly: true,
      optInPersistenceAndDisabledRouteFallback: true,
      legacyExplicitChoicesPreserved: true,
      noOptionalInitializationBeforeOpen: true,
      simUnavailableAndOffline: true,
      actualChatDevNavigation: true,
      grantsWhileOffline: 0,
    })
  )
} catch (error) {
  console.error(JSON.stringify({ requests, errors }))
  console.error((await page.locator('body').innerText()).slice(0, 8000))
  throw error
} finally {
  await browser.close()
  server.stop(true)
}
