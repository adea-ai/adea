// Mounted Agent edit-revision gate (issue #1213).
//
// The production shell, controller, API client, roster and customization form are
// driven in a real browser against a mocked workspace API. What it pins:
//
// 1. A stale opening conflicts (`AGENT_REVISION_CONFLICT`) and stops the save, so the
//    later steps of a multi-step save never write over another editor.
// 2. A partial multi-step save keeps the step that already succeeded and reports the
//    failing one instead of silently dropping it.
// 3. After a conflict, a refetch resumes from the revision the server reports rather
//    than the revision the stale window opened, and the whole save lands.
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
const projects = [
  {
    createdAt: timestamp,
    iconKey: 'product',
    id: 'project-product',
    lifecycleState: 'active' as const,
    name: 'Product',
    sortOrder: 0,
    updatedAt: timestamp,
    workspaceId: workspace.id,
  },
]

type AgentRow = {
  createdAt: string
  id: string
  lifecycleState: 'active'
  name: string
  presentationMetadata: Readonly<Record<string, string>>
  profile: { id: string; state: string; version: string; revision: number }
  projectId: string | null
  revision: number
  roleSummary: string
  updatedAt: string
  workspaceId: string
}

function agent(partial: Partial<AgentRow> = {}): AgentRow {
  return {
    createdAt: timestamp,
    id: 'agent-research',
    lifecycleState: 'active',
    name: 'Research Agent',
    presentationMetadata: {},
    profile: { id: 'profile-research', state: 'available', revision: 0, version: '1' },
    projectId: null,
    revision: 0,
    roleSummary: 'Customer and market research',
    updatedAt: timestamp,
    workspaceId: workspace.id,
    ...partial,
  }
}

type StepOutcome = 'ok' | 'conflict'
type Recorded = { body: unknown; method: string; path: string }

type Fixture = {
  /** Every workspace API request the app issued, in order. */
  requests: Recorded[]
  /** Server truth for the Agent, mutated by accepted edits. */
  server: { agent: AgentRow }
  /** Per-step outcome the mock server answers. */
  outcomes: { presentation: StepOutcome; profile: StepOutcome; project: StepOutcome }
}

const AGENT_ID = 'agent-research'
const conflictNotice = 'Agent changed. Close, refresh and review the current version.'
const agentPath = (path: string) => `/api/v1/workspaces/${workspace.id}/agents/${path}`

const conflict = (route: Route) =>
  route.fulfill({
    contentType: 'application/json',
    json: { code: 'AGENT_REVISION_CONFLICT', message: 'Agent changed; refresh and retry' },
    status: 409,
  })

function editRequests(fixture: Fixture): Recorded[] {
  return fixture.requests.filter((request) =>
    ['presentation', 'project', 'profile'].some((step) => request.path.endsWith(`/${step}`))
  )
}

function steps(requests: Recorded[]): [string, string][] {
  return requests.map(
    (request) =>
      [request.method, request.path.split('/agents/')[1]!.split('/')[1]!] as [string, string]
  )
}

async function mountAgentEdits(page: Page, fixture: Partial<Fixture> = {}): Promise<Fixture> {
  const state: Fixture = {
    requests: fixture.requests ?? [],
    server: fixture.server ?? { agent: agent() },
    outcomes: fixture.outcomes ?? { presentation: 'ok', profile: 'ok', project: 'ok' },
  }

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
        principal: { temporary: true, userId: 'user-e2e' },
        workspaces: [workspace],
      },
    })
  )
  await page.route('**/api/v1/account/summary', (route) =>
    route.fulfill({ contentType: 'application/json', json: { workspaces: [] } })
  )

  // Registered last, so it wins the route match; each branch keeps its own step.
  await page.route('**/api/v1/workspaces/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const body = request.postDataJSON?.() ?? null
    state.requests.push({ body, method, path: url.pathname })

    if (method === 'PATCH' && url.pathname === agentPath(`${AGENT_ID}/presentation`)) {
      if (state.outcomes.presentation === 'conflict') return conflict(route)
      const name = (body as { name?: string }).name ?? state.server.agent.name
      state.server.agent = {
        ...state.server.agent,
        name,
        revision: state.server.agent.revision + 1,
      }
      return route.fulfill({ contentType: 'application/json', json: { agent: state.server.agent } })
    }
    if (method === 'POST' && url.pathname === agentPath(`${AGENT_ID}/project`)) {
      if (state.outcomes.project === 'conflict') return conflict(route)
      const projectId = (body as { projectId: string | null }).projectId
      state.server.agent = {
        ...state.server.agent,
        projectId,
        revision: state.server.agent.revision + 1,
      }
      return route.fulfill({ contentType: 'application/json', json: { agent: state.server.agent } })
    }
    if (method === 'POST' && url.pathname === agentPath(`${AGENT_ID}/profile`)) {
      if (state.outcomes.profile === 'conflict') return conflict(route)
      const input = body as { profileId: string; profileVersion: string }
      state.server.agent = {
        ...state.server.agent,
        profile: {
          ...state.server.agent.profile,
          id: input.profileId,
          revision: state.server.agent.profile.revision + 1,
          version: input.profileVersion,
        },
      }
      return route.fulfill({ contentType: 'application/json', json: { agent: state.server.agent } })
    }

    if (method !== 'GET') return route.fulfill({ contentType: 'application/json', json: {} })
    if (url.pathname.endsWith('/agents'))
      return route.fulfill({ contentType: 'application/json', json: [state.server.agent] })
    if (url.pathname.endsWith('/projects'))
      return route.fulfill({ contentType: 'application/json', json: projects })
    if (url.pathname.includes('/read-state'))
      return route.fulfill({ contentType: 'application/json', json: { readState: [] } })
    if (
      url.pathname.endsWith('/channels') ||
      url.pathname.endsWith('/tasks') ||
      url.pathname.endsWith('/artifacts') ||
      url.pathname.endsWith('/members') ||
      url.pathname.endsWith('/messages')
    )
      return route.fulfill({ contentType: 'application/json', json: [] })
    return route.fulfill({ contentType: 'application/json', json: {} })
  })
  return state
}

/** Settings → Agents → the roster's customize form, the route a user takes. */
async function openCustomization(page: Page) {
  await page.goto('/#settings/privacy-data')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await settings.getByRole('tab', { name: 'Agents' }).click()
  await settings.getByRole('button', { name: 'Customize Agents' }).click()
  await page.getByRole('button', { name: 'Customize', exact: true }).first().click()
  return page.locator('form.conventional-agent-customization')
}

test('a stale Agent save conflicts and never writes the later steps of its save', async ({
  page,
}) => {
  const fixture = await mountAgentEdits(page, {
    outcomes: { presentation: 'conflict', profile: 'ok', project: 'ok' },
  })
  const form = await openCustomization(page)
  await form.getByLabel('Name').fill('Renamed by a stale window')
  await form.getByRole('button', { name: 'Save changes' }).click()

  await expect(page.getByText(conflictNotice)).toBeVisible()
  // The form stays open on the opening snapshot instead of pretending it saved.
  await expect(page.getByRole('heading', { name: 'Customize Research Agent' })).toBeVisible()
  expect(steps(editRequests(fixture))).toEqual([['PATCH', 'presentation']])
  expect(fixture.server.agent).toMatchObject({ name: 'Research Agent', revision: 0 })
})

test('a partial multi-step save keeps its completed step and reports the conflicting one', async ({
  page,
}) => {
  const fixture = await mountAgentEdits(page, {
    outcomes: { presentation: 'ok', profile: 'ok', project: 'conflict' },
  })
  const form = await openCustomization(page)
  await form.getByLabel('Name').fill('Renamed before placement')
  await form.getByLabel('Project').selectOption('project-product')
  await form.getByLabel('Profile version ID').fill('pfv_01JABCDEF0123456789ABCDEFG')
  await form.getByRole('button', { name: 'Save changes' }).click()

  await expect(page.getByText(conflictNotice)).toBeVisible()
  const edits = editRequests(fixture)
  expect(steps(edits)).toEqual([
    ['PATCH', 'presentation'],
    ['POST', 'project'],
  ])
  // The presentation step committed and survived the step that conflicted.
  expect(fixture.server.agent).toMatchObject({
    name: 'Renamed before placement',
    projectId: null,
    revision: 1,
  })
  // The placement edit chained the revision its predecessor's response returned.
  expect(edits[1]?.body).toMatchObject({ expectedRevision: 1, projectId: 'project-product' })
  // The profile step never ran after the conflict.
  expect(edits.some((request) => request.path.endsWith('/profile'))).toBe(false)
})

test('after a conflict a refetch resumes from the server revision and saves end to end', async ({
  page,
}) => {
  const fixture = await mountAgentEdits(page, {
    outcomes: { presentation: 'conflict', profile: 'ok', project: 'ok' },
  })
  const staleForm = await openCustomization(page)
  await staleForm.getByLabel('Name').fill('Lost by the stale window')
  await staleForm.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText(conflictNotice)).toBeVisible()

  // Another editor wins while this one is looking at a stale form.
  fixture.server.agent = agent({
    name: 'Renamed elsewhere',
    revision: 1,
    updatedAt: '2026-08-30T12:01:00.000Z',
  })
  fixture.outcomes.presentation = 'ok'

  await page.reload()
  const form = await openCustomization(page)
  await expect(form.getByLabel('Name')).toHaveValue('Renamed elsewhere')
  await form.getByLabel('Name').fill('Renamed after refetch')
  await form.getByLabel('Project').selectOption('project-product')
  await form.getByLabel('Profile version ID').fill('pfv_01JABCDEF0123456789ABCDEFG')
  await form.getByRole('button', { name: 'Save changes' }).click()

  // The save closes: every step was accepted from the refetched revision.
  await expect(page.locator('form.conventional-agent-customization')).toHaveCount(0)
  const resubmitted = editRequests(fixture).slice(-3)
  expect(steps(resubmitted)).toEqual([
    ['PATCH', 'presentation'],
    ['POST', 'project'],
    ['POST', 'profile'],
  ])
  expect(resubmitted[0]?.body).toMatchObject({ expectedRevision: 1, name: 'Renamed after refetch' })
  expect(resubmitted[1]?.body).toMatchObject({ expectedRevision: 2, projectId: 'project-product' })
  // The profile pin keeps its own revision, opened from the same refetched snapshot.
  expect(resubmitted[2]?.body).toMatchObject({
    expectedRevision: 0,
    profileVersion: 'pfv_01JABCDEF0123456789ABCDEFG',
  })
  expect(fixture.server.agent).toMatchObject({ name: 'Renamed after refetch', revision: 3 })
})
