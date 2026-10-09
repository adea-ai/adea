// Canonical lead setup through the production shell's Agents entry.
// The shell, controller, API client and roster run in a real browser against a
// mocked workspace API. The lead is provisioned from the Agents entry only when
// none exists, the roster keeps listing its available agent either way, and a
// broken lead route shows a retryable error without hiding direct roster work.
import { expect, test, type Page, type Route } from '@playwright/test'

const timestamp = '2026-08-30T12:00:00.000Z'
const workspace = {
  accent: null,
  id: 'workspace-e2e',
  logo: { kind: 'monogram' as const },
  name: 'Work',
  scene: 'work',
  sortOrder: 0,
  updatedAt: timestamp,
  version: 1,
}
const researchAgent = {
  createdAt: timestamp,
  id: 'agent-research',
  lifecycleState: 'active',
  name: 'Research Agent',
  presentationMetadata: {},
  profile: { id: 'profile-research', state: 'available', version: '1' },
  projectId: null,
  revision: 0,
  roleSummary: 'Finds sources',
  updatedAt: timestamp,
  workspaceId: workspace.id,
}

type LeadState = {
  lead: Record<string, unknown> | null
  postsFail: number
  posts: number
  gets: number
}

async function mountShell(page: Page): Promise<LeadState> {
  const state: LeadState = { lead: null, postsFail: 0, posts: 0, gets: 0 }
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('adea:e2e-initialized')) {
      localStorage.clear()
      localStorage.setItem('theme', 'light')
      sessionStorage.setItem('adea:e2e-initialized', 'true')
    }
  })
  await page.route('**/api/workspaces/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        activeWorkspace: workspace,
        principal: { temporary: false, userId: 'user-e2e' },
        workspaces: [workspace],
      },
    })
  )
  await page.route('**/api/v1/account/summary', (route) =>
    route.fulfill({ contentType: 'application/json', json: { workspaces: [] } })
  )
  // Model metadata is unavailable in this environment, so lead funding fails closed.
  await page.route('**/api/workspaces/workspace-e2e/model-connections', (route: Route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        availability: 'unavailable',
        canManage: false,
        target: null,
        connections: [],
        defaults: null,
      },
    })
  )
  await page.route('**/api/v1/workspaces/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    if (url.pathname.endsWith('/agents/lead')) {
      if (method === 'GET') {
        state.gets += 1
        return route.fulfill({ contentType: 'application/json', json: { lead: state.lead } })
      }
      state.posts += 1
      if (state.postsFail > 0) {
        state.postsFail -= 1
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          json: { code: 'workspace_unavailable', message: 'Workspace unavailable' },
        })
      }
      state.lead ??= {
        createdAt: timestamp,
        id: 'agent-lead',
        isWorkspaceLead: true,
        lifecycleState: 'active',
        name: 'Workspace lead',
        presentationMetadata: {},
        profile: { id: 'workspace-lead-unconfigured', state: 'missing', version: 'unconfigured' },
        projectId: null,
        revision: 0,
        roleSummary: 'Coordinates work in this workspace',
        updatedAt: timestamp,
        workspaceId: workspace.id,
      }
      return route.fulfill({ contentType: 'application/json', json: { lead: state.lead } })
    }
    if (method !== 'GET') return route.fulfill({ contentType: 'application/json', json: {} })
    if (url.pathname.endsWith('/agents'))
      return route.fulfill({ contentType: 'application/json', json: [researchAgent] })
    if (url.pathname.endsWith('/projects') || url.pathname.endsWith('/tasks'))
      return route.fulfill({ contentType: 'application/json', json: [] })
    if (url.pathname.includes('/read-state'))
      return route.fulfill({ contentType: 'application/json', json: { readState: [] } })
    if (
      url.pathname.endsWith('/channels') ||
      url.pathname.endsWith('/artifacts') ||
      url.pathname.endsWith('/members') ||
      url.pathname.endsWith('/messages')
    )
      return route.fulfill({ contentType: 'application/json', json: [] })
    return route.fulfill({ contentType: 'application/json', json: {} })
  })
  await page.goto('/')
  return state
}

const leadStatus = (page: Page) => page.getByRole('region', { name: 'Workspace lead' })

async function openAgents(page: Page) {
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
}

test('the Agents entry provisions the structural lead once and keeps the roster usable', async ({
  page,
}) => {
  const state = await mountShell(page)
  await openAgents(page)
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'unconfigured',
    { timeout: 30_000 }
  )
  // The available roster agent is not the lead: setup never reads as ready.
  await expect(leadStatus(page)).not.toContainText('ready')
  await expect(page.getByText('Research Agent').first()).toBeVisible()
  expect(state.posts).toBe(1)
})

test('re-entering Agents after a reload does not provision the lead again', async ({ page }) => {
  const state = await mountShell(page)
  await openAgents(page)
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'unconfigured',
    { timeout: 30_000 }
  )
  await page.reload()
  await openAgents(page)
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'unconfigured',
    { timeout: 30_000 }
  )
  expect(state.posts).toBe(1)
  expect(state.gets).toBeGreaterThanOrEqual(2)
})

test('a failed lead provisioning shows a retryable error while the roster stays usable', async ({
  page,
}) => {
  const state = await mountShell(page)
  state.postsFail = 1
  await openAgents(page)
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'provisioning_failed',
    { timeout: 30_000 }
  )
  await expect(page.getByText('Research Agent').first()).toBeVisible()
  await leadStatus(page).getByRole('button', { name: 'Try again' }).click()
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'unconfigured'
  )
  expect(state.posts).toBe(2)
})
