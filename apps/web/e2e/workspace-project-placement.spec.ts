import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { inArray, sql } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../../packages/db/src/connection'
import { createDirectAgentTopic } from '../../../packages/db/src/conversations'
import { ensureWorkspaceLead } from '../../../packages/db/src/agents'
import {
  authorizationAuditRecords,
  channelParticipants,
  channelReadStates,
  channels,
  messageMentions,
  messages,
  projectMembers,
  projects,
  tasks,
  temporaryUserSessions,
  threadReadStates,
  users,
  workspaceMemberships,
  workspaces,
} from '../../../packages/db/src/schema'
import { addWorkspaceMembership } from '../../../packages/db/src/workspaces'

// ---------------------------------------------------------------------------
// Coverage class: workspace/project placement over the real app server (the
// lane's Vite dev server hosting the TanStack Start worker) and the REAL
// restricted Postgres over real HTTP — the same class as
// account-directory-auth.spec.ts and chat-continuity.spec.ts. No request is
// mocked: `page.route` is never used. Fixtures are created through the
// @adea-ai/db domain functions and every created id is deleted again in
// afterAll, which runs on success AND failure. A missing or unreachable
// database fails the lane; nothing skips.
//
// What this proves that harness suites cannot: channels, tasks, messages,
// and projects stay inside the workspace and project they were placed in —
// listings never cross the boundary, cross-workspace reads and writes fence
// without leaking, members-only projects hide their content from
// non-members, and visibility changes re-place content both ways.
// Session/host identity stays out of scope here: the cloud holds no session
// facts, so placement is proven for the server-known chain (workspace ->
// project -> channel / task / message) with the credential only ever
// proving login.
// ---------------------------------------------------------------------------

// Same fallback contract as playwright.config.ts: CI provides DATABASE_URL;
// local shells fall back to the compose Postgres that `bun run test:e2e`
// starts (scripts/e2e-setup.mjs).
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable'

type Principal = { kind: 'user'; userId: string }

/** Reads go through the browser's own origin, cookie jar and network stack. */
async function fetchFromPage<T>(
  page: Page,
  route: string,
  init?: { method?: string; body?: unknown }
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ target, options }) => {
      const response = await fetch(target, {
        method: options.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      return { status: response.status, body: (await response.json()) as T }
    },
    { target: route, options: { method: init?.method, body: init?.body } }
  )
}

/** Real sign-in: the browser asks the app itself for a session. */
async function signIn(
  connection: DatabaseConnection,
  workspaceIds: string[],
  userIds: string[],
  context: BrowserContext
): Promise<{ principal: Principal; workspaceId: string; page: Page }> {
  const response = await context.request.post('/api/workspaces/bootstrap')
  expect(response.status()).toBe(200)
  const payload = (await response.json()) as {
    principal: { temporary: boolean; userId: string }
    workspaces: { id: string }[]
  }
  expect(payload.principal.temporary).toBe(true)
  const workspaceId = payload.workspaces[0]!.id
  workspaceIds.push(workspaceId)
  userIds.push(payload.principal.userId)
  return {
    principal: { kind: 'user', userId: payload.principal.userId },
    workspaceId,
    page: await context.newPage(),
  }
}

async function directTopic(
  connection: DatabaseConnection,
  workspaceId: string,
  owner: Principal,
  title: string
): Promise<string> {
  const lead = await ensureWorkspaceLead(connection.db, workspaceId, owner)
  const topic = await createDirectAgentTopic(connection.db, workspaceId, lead.id, owner, {
    title,
    idempotencyKey: crypto.randomUUID(),
  })
  return topic.id
}

test.describe('workspace and project placement over real routes', () => {
  // The lane runs with one worker (playwright.config.ts); these tests share
  // one database connection and one tracked fixture set.
  let connection: DatabaseConnection
  const workspaceIds: string[] = []
  const userIds: string[] = []

  test.beforeAll(async () => {
    connection = createDatabase(databaseUrl)
    try {
      await connection.db.execute(sql`select 1`)
    } catch {
      await connection.close().catch(() => undefined)
      throw new Error(
        'The placement browser lane requires the restricted local Postgres: run it through `bun run test:e2e` (which starts the compose Postgres or requires DATABASE_URL). It never skips.'
      )
    }
  })

  test.afterAll(async () => {
    // FK-ordered teardown; runs on success and failure, and a cleanup
    // failure fails the lane rather than leaking rows.
    const db = connection.db
    if (workspaceIds.length) {
      await db
        .delete(authorizationAuditRecords)
        .where(inArray(authorizationAuditRecords.workspaceId, workspaceIds))
      await db.delete(threadReadStates).where(inArray(threadReadStates.workspaceId, workspaceIds))
      await db.delete(channelReadStates).where(inArray(channelReadStates.workspaceId, workspaceIds))
      await db.delete(messageMentions).where(inArray(messageMentions.workspaceId, workspaceIds))
      await db.delete(messages).where(inArray(messages.workspaceId, workspaceIds))
      await db
        .delete(channelParticipants)
        .where(inArray(channelParticipants.workspaceId, workspaceIds))
      await db.delete(channels).where(inArray(channels.workspaceId, workspaceIds))
      await db.delete(tasks).where(inArray(tasks.workspaceId, workspaceIds))
      await db.delete(projectMembers).where(inArray(projectMembers.workspaceId, workspaceIds))
      await db.delete(projects).where(inArray(projects.workspaceId, workspaceIds))
      await db
        .delete(workspaceMemberships)
        .where(inArray(workspaceMemberships.workspaceId, workspaceIds))
    }
    if (userIds.length) {
      await db.delete(temporaryUserSessions).where(inArray(temporaryUserSessions.userId, userIds))
      await db.delete(users).where(inArray(users.id, userIds))
    }
    if (workspaceIds.length) {
      await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds))
    }
    await connection.close().catch(() => undefined)
  })

  test('channels list stays inside their workspace', async ({ browser }) => {
    const first = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const channelId = await directTopic(connection, first.workspaceId, first.principal, 'Placed DM')
    const listed = await fetchFromPage<{ id: string }[]>(
      first.page,
      `/api/v1/workspaces/${first.workspaceId}/channels`
    )
    expect(listed.status).toBe(200)
    expect(listed.body.map((channel) => channel.id)).toContain(channelId)

    const second = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const foreign = await fetchFromPage<{ id: string }[]>(
      second.page,
      `/api/v1/workspaces/${second.workspaceId}/channels`
    )
    expect(foreign.status).toBe(200)
    expect(foreign.body.map((channel) => channel.id)).not.toContain(channelId)
    await first.page.context().close()
    await second.page.context().close()
  })

  test('cross-workspace channel reads fence without leaking', async ({ browser }) => {
    const home = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const channelId = await directTopic(connection, home.workspaceId, home.principal, 'Home DM')
    const away = await signIn(connection, workspaceIds, userIds, await browser.newContext())

    // Through the stranger's own workspace the channel does not exist;
    // through the home workspace the stranger is not a member. Either way
    // the status is not 200 and no message body ever crosses.
    for (const workspaceId of [away.workspaceId, home.workspaceId]) {
      const read = await fetchFromPage<{ messages?: unknown }>(
        away.page,
        `/api/v1/workspaces/${workspaceId}/channels/${channelId}/messages`
      )
      expect(read.status).not.toBe(200)
    }
    await home.page.context().close()
    await away.page.context().close()
  })

  test('tasks stay inside their workspace', async ({ browser }) => {
    const owner = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const created = await fetchFromPage<{ task: { id: string } }>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/tasks`,
      { method: 'POST', body: { title: 'Placed task', objective: 'Do placed work' } }
    )
    expect(created.status).toBe(201)

    const listed = await fetchFromPage<{ id: string }[]>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/tasks`
    )
    expect(listed.status).toBe(200)
    expect(listed.body.map((task) => task.id)).toContain(created.body.task.id)

    const stranger = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const foreign = await fetchFromPage<{ id: string }[]>(
      stranger.page,
      `/api/v1/workspaces/${stranger.workspaceId}/tasks`
    )
    expect(foreign.body.map((task) => task.id)).not.toContain(created.body.task.id)
    const direct = await fetchFromPage<{ task?: unknown }>(
      stranger.page,
      `/api/v1/workspaces/${owner.workspaceId}/tasks/${created.body.task.id}`
    )
    expect(direct.status).not.toBe(200)
    await owner.page.context().close()
    await stranger.page.context().close()
  })

  test('members-only projects hide tasks and messages from non-members', async ({ browser }) => {
    const owner = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const created = await fetchFromPage<{ project: { id: string } }>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/projects`,
      { method: 'POST', body: { name: 'Secret plans', iconKey: 'lock' } }
    )
    expect(created.status).toBe(201)
    const projectId = created.body.project.id
    const visibility = await fetchFromPage<{ project?: { visibility?: string } }>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/projects/${projectId}/visibility`,
      { method: 'PATCH', body: { visibility: 'members' } }
    )
    expect(visibility.status).toBe(200)

    const task = await fetchFromPage<{ task: { id: string } }>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/tasks`,
      {
        method: 'POST',
        body: { title: 'Secret task', objective: 'Hidden work', projectId },
      }
    )
    expect(task.status).toBe(201)
    const channelId = await directTopic(connection, owner.workspaceId, owner.principal, 'Secret DM')
    const posted = await fetchFromPage<{ message: { id: string } }>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/channels/${channelId}/messages`,
      { method: 'POST', body: { bodyText: 'secret line', taskId: task.body.task.id } }
    )
    expect(posted.status).toBe(201)

    // A workspace member who is not on the project reads the workspace but
    // never the hidden project's content.
    const member = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    await addWorkspaceMembership(connection.db, owner.workspaceId, member.principal, 'member')
    const hiddenTask = await fetchFromPage<{ task?: unknown }>(
      member.page,
      `/api/v1/workspaces/${owner.workspaceId}/tasks/${task.body.task.id}`
    )
    expect(hiddenTask.status).not.toBe(200)
    const hiddenMessage = await fetchFromPage<{ messages?: { id?: string }[] }>(
      member.page,
      `/api/v1/workspaces/${owner.workspaceId}/channels/${channelId}/messages`
    )
    expect(
      hiddenMessage.status !== 200 ||
        !(hiddenMessage.body.messages ?? []).some(
          (message) => message.id === posted.body.message.id
        )
    ).toBe(true)
    await owner.page.context().close()
    await member.page.context().close()
  })

  test('visibility changes re-place project content both ways', async ({ browser }) => {
    const owner = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const created = await fetchFromPage<{ project: { id: string } }>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/projects`,
      { method: 'POST', body: { name: 'Flip plans', iconKey: 'lock' } }
    )
    expect(created.status).toBe(201)
    const projectId = created.body.project.id
    const projectPath = `/api/v1/workspaces/${owner.workspaceId}/projects/${projectId}`

    const member = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    await addWorkspaceMembership(connection.db, owner.workspaceId, member.principal, 'member')

    // Workspace-visible projects list for every member.
    const listed = await fetchFromPage<{ id: string }[]>(
      member.page,
      `/api/v1/workspaces/${owner.workspaceId}/projects`
    )
    expect(listed.body.map((project) => project.id)).toContain(projectId)

    // Restricting to members hides it; reopening reveals it again.
    const restricted = await fetchFromPage(member.page, projectPath + '/visibility', {
      method: 'PATCH',
      body: { visibility: 'members' },
    })
    expect(restricted.status).toBe(200)
    const hidden = await fetchFromPage<{ project?: unknown }>(member.page, projectPath)
    expect(hidden.status).not.toBe(200)
    const reopened = await fetchFromPage(member.page, projectPath + '/visibility', {
      method: 'PATCH',
      body: { visibility: 'workspace' },
    })
    // The member cannot change visibility themselves: only a manager can.
    expect(reopened.status).not.toBe(200)
    const ownerReopened = await fetchFromPage(owner.page, projectPath + '/visibility', {
      method: 'PATCH',
      body: { visibility: 'workspace' },
    })
    expect(ownerReopened.status).toBe(200)
    const visible = await fetchFromPage<{ project?: { id: string } }>(member.page, projectPath)
    expect(visible.status).toBe(200)
    await owner.page.context().close()
    await member.page.context().close()
  })

  test('cross-workspace writes never land', async ({ browser }) => {
    const home = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const channelId = await directTopic(connection, home.workspaceId, home.principal, 'Guarded DM')
    const away = await signIn(connection, workspaceIds, userIds, await browser.newContext())

    // The stranger posts into the home channel: the write fences, and the
    // home transcript never shows the forged line.
    const forged = await fetchFromPage<{ message?: { id: string } }>(
      away.page,
      `/api/v1/workspaces/${home.workspaceId}/channels/${channelId}/messages`,
      { method: 'POST', body: { bodyText: 'forged line' } }
    )
    expect(forged.status).not.toBe(201)
    const read = await fetchFromPage<{ messages: { bodyText?: string }[] }>(
      home.page,
      `/api/v1/workspaces/${home.workspaceId}/channels/${channelId}/messages`
    )
    expect(read.status).toBe(200)
    expect(read.body.messages.map((message) => message.bodyText)).not.toContain('forged line')
    await home.page.context().close()
    await away.page.context().close()
  })
})
