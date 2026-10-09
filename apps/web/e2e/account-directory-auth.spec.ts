import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'

import { createAgent } from '../../../packages/db/src/agents'
import {
  createGroupChannel,
  createMessage,
  setChannelParticipants,
} from '../../../packages/db/src/conversations'
import { createDatabase, type DatabaseConnection } from '../../../packages/db/src/connection'
import { createTemporaryUserSession } from '../../../packages/db/src/identity'
import { markChannelReadState } from '../../../packages/db/src/read-state'
import {
  addWorkspaceMembership,
  createWorkspaceWithOwner,
} from '../../../packages/db/src/workspaces'
import {
  agents,
  authorizationAuditRecords,
  channelParticipants,
  channelReadStates,
  channels,
  messageMentions,
  messages,
  projects,
  temporaryUserSessions,
  threadReadStates,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../../packages/db/src/schema'

// ---------------------------------------------------------------------------
// Coverage class: actual-authentication browser coverage.
//
// These tests drive the REAL app server (the lane's Vite dev server hosting
// the TanStack Start worker) and the REAL restricted Postgres over real HTTP.
// No request is mocked: `page.route` is never used. Authentication is the
// app's own session machinery end to end — the server mints a session
// credential in the database, hands it to the browser as an HttpOnly cookie,
// and every later request is re-resolved from that cookie by the real
// `resolveWorkspacePrincipal` before the account routes answer.
//
// What this class proves that the injected-seam route-flow suite
// (apps/web/test/integration, part of `bun run test:integration`) cannot: the
// cookie jar, the HTTP surface (status lines, cache headers, JSON bodies), the
// server-side session round trip, and offline/reconnect behaviour as a real
// browser experiences them. What it deliberately does NOT cover: the
// email-and-password provider sign-in form — that flow needs the hosted Neon
// auth provider and stays in the hosted acceptance lane
// (apps/web/start/acceptance-sign-in.mjs). The temporary-session class minted
// here is the only account class the local lane can issue, and it exercises
// the identical principal resolution the provider sessions flow through.
//
// Fixtures follow the restricted-Postgres pattern of the route-flow suite:
// rows are created through the @adea-ai/db domain functions and every created
// id is deleted again in afterAll, which runs on success AND failure. A
// missing or unreachable database fails the lane; nothing skips.
// ---------------------------------------------------------------------------

// Same fallback contract as playwright.config.ts: CI provides DATABASE_URL;
// local shells fall back to the compose Postgres that `bun run test:e2e`
// starts (scripts/e2e-setup.mjs).
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable'

// The unauthenticated account answer is a constant: every fenced, anonymous,
// or revoked request must be identical to it.
const UNAUTHENTICATED_BODY = {
  code: 'workspace_unavailable',
  message: 'Workspace unavailable',
}

type Principal = { kind: 'user'; userId: string }
type InboxEntry = {
  id: string
  title: string
  unread: boolean
  topLevelUnreadCount: number
  latestTopLevelSequence: number
}
type InboxPage = { conversations: InboxEntry[] }
type DirectoryPage = { agents: { id: string; name: string }[] }

/**
 * The account routes are fetched from inside the real page: the browser's
 * own origin, cookie jar and network stack, not Playwright's request client.
 */
async function fetchFromPage<T>(page: Page, route: string) {
  return page.evaluate(async (target) => {
    const response = await fetch(target)
    return {
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      body: (await response.json()) as T,
    }
  }, route)
}

async function openSignedInApp(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'User settings' })).toBeVisible({
    timeout: 20_000,
  })
}

test.describe('account directory routes behind real sign-in', () => {
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
        'The account directory browser lane requires the restricted local Postgres: run it through `bun run test:e2e` (which starts the compose Postgres or requires DATABASE_URL). It never skips.'
      )
    }
  })

  test.afterAll(async () => {
    // Mirror the route-flow suite's FK-ordered teardown, extended by the audit
    // rows the app's own authorization decisions write. Runs on success and
    // failure; a cleanup failure fails the lane rather than leaking rows.
    const db = connection.db
    if (workspaceIds.length) {
      await db
        .delete(authorizationAuditRecords)
        .where(inArray(authorizationAuditRecords.workspaceId, workspaceIds))
      await db.delete(threadReadStates).where(inArray(threadReadStates.workspaceId, workspaceIds))
      await db.delete(channelReadStates).where(inArray(channelReadStates.workspaceId, workspaceIds))
      await db.delete(messageMentions).where(inArray(messageMentions.workspaceId, workspaceIds))
      // Replies reference their roots; drop them first.
      await db
        .delete(messages)
        .where(
          and(inArray(messages.workspaceId, workspaceIds), isNotNull(messages.threadRootMessageId))
        )
      await db.delete(messages).where(inArray(messages.workspaceId, workspaceIds))
      await db
        .delete(channelParticipants)
        .where(inArray(channelParticipants.workspaceId, workspaceIds))
      await db.delete(channels).where(inArray(channels.workspaceId, workspaceIds))
      await db.delete(agents).where(inArray(agents.workspaceId, workspaceIds))
      // project_members cascade with their projects.
      await db.delete(projects).where(inArray(projects.workspaceId, workspaceIds))
      await db.delete(workspaceEvents).where(inArray(workspaceEvents.workspaceId, workspaceIds))
      await db
        .delete(workspaceMemberships)
        .where(inArray(workspaceMemberships.workspaceId, workspaceIds))
      await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds))
    }
    for (const userId of userIds) {
      await db.delete(temporaryUserSessions).where(eq(temporaryUserSessions.userId, userId))
      await db.delete(users).where(eq(users.id, userId))
    }
    await connection.close()
  })

  /**
   * Real sign-in: the browser asks the app itself for a session, the server
   * mints the credential row and the HttpOnly cookie, and the response names
   * the principal every later request resolves back to.
   */
  async function signIn(context: BrowserContext): Promise<Principal> {
    const response = await context.request.post('/api/workspaces/bootstrap')
    expect(response.status()).toBe(200)
    const payload = (await response.json()) as {
      principal: { temporary: boolean; userId: string }
      sessionRotated: boolean
      workspaces: { id: string }[]
    }
    expect(payload.principal.temporary).toBe(true)
    expect(payload.sessionRotated).toBe(false)
    for (const workspace of payload.workspaces) workspaceIds.push(workspace.id)
    const cookies = await context.cookies()
    expect(
      cookies.some((cookie) => cookie.httpOnly && cookie.name === 'agent_hq_temporary_session')
    ).toBe(true)
    const principal: Principal = { kind: 'user', userId: payload.principal.userId }
    userIds.push(principal.userId)
    return principal
  }

  /** A background participant that never signs in; used to generate activity. */
  async function backgroundUser(label: string): Promise<Principal> {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: `browser-${label}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 300_000),
    })
    userIds.push(session.principal.userId)
    return session.principal
  }

  async function seedWorkspace(owner: Principal, name: string): Promise<string> {
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `browser-${crypto.randomUUID()}`,
      name,
      owner,
    })
    workspaceIds.push(workspace.id)
    return workspace.id
  }

  async function seedAgent(workspaceId: string, owner: Principal, name: string) {
    return createAgent(connection.db, workspaceId, owner, {
      name,
      profileId: `prf_${'0'.repeat(25)}1`,
      profileVersion: `pfv_${'0'.repeat(25)}1`,
    })
  }

  async function seedConversation(
    workspaceId: string,
    owner: Principal,
    title: string,
    participants: readonly Principal[] = []
  ) {
    const channel = await createGroupChannel(connection.db, workspaceId, owner, {
      idempotencyKey: `browser-${crypto.randomUUID()}`,
      title,
    })
    if (participants.length)
      await setChannelParticipants(
        connection.db,
        workspaceId,
        channel.id,
        owner,
        participants.map((participant) => ({ kind: 'user' as const, userId: participant.userId })),
        channel.version
      )
    return channel
  }

  async function seedMessage(
    workspaceId: string,
    channelId: string,
    sender: Principal
  ): Promise<void> {
    await createMessage(connection.db, workspaceId, channelId, sender, {
      bodyText: 'browser fixture',
      idempotencyKey: crypto.randomUUID(),
      sender,
    })
  }

  test('real sign-in gates the account routes end-to-end', async ({ page, context }) => {
    test.slow()
    // Before any session exists the account space answers the constant
    // unauthenticated response, privately.
    const anonymous = await context.request.get('/api/v1/account/agents')
    expect(anonymous.status()).toBe(401)
    expect(anonymous.headers()['cache-control']).toBe('private, no-store')
    expect(await anonymous.json()).toEqual(UNAUTHENTICATED_BODY)

    // Real sign-in through the app's own session flow.
    const owner = await signIn(context)
    const workspaceId = await seedWorkspace(owner, 'Browser Account HQ')
    const agent = await seedAgent(workspaceId, owner, 'Browser Directory Agent')
    const conversation = await seedConversation(workspaceId, owner, 'Browser Inbox Lane')
    await seedMessage(workspaceId, conversation.id, owner)

    // The signed-in app renders, and the page's own fetches carry the session.
    await openSignedInApp(page)

    const directory = await fetchFromPage<DirectoryPage>(page, '/api/v1/account/agents')
    expect(directory.status).toBe(200)
    expect(directory.cacheControl).toBe('private, no-store')
    expect(directory.body.agents.map(({ id }) => id)).toContain(agent.id)
    expect(directory.body.agents.find(({ id }) => id === agent.id)?.name).toBe(
      'Browser Directory Agent'
    )

    const inbox = await fetchFromPage<InboxPage>(page, '/api/v1/account/conversations')
    expect(inbox.status).toBe(200)
    expect(inbox.body.conversations.map(({ id }) => id)).toContain(conversation.id)
    expect(inbox.body.conversations.find(({ id }) => id === conversation.id)?.title).toBe(
      'Browser Inbox Lane'
    )

    // Deep links through the page resolve the same rows.
    const agentLookup = await fetchFromPage(page, `/api/v1/account/agents/${agent.id}`)
    expect(agentLookup.status).toBe(200)
    const conversationLookup = await fetchFromPage(
      page,
      `/api/v1/account/conversations/${conversation.id}`
    )
    expect(conversationLookup.status).toBe(200)
  })

  test('account-wide results span workspaces and stay stable', async ({ page, context }) => {
    test.slow()
    const owner = await signIn(context)
    const first = await seedWorkspace(owner, 'Browser Span One')
    const second = await seedWorkspace(owner, 'Browser Span Two')
    const firstAgent = await seedAgent(first, owner, 'Browser Span Agent One')
    const secondAgent = await seedAgent(second, owner, 'Browser Span Agent Two')
    const firstConversation = await seedConversation(first, owner, 'Browser Span Lane One')
    const secondConversation = await seedConversation(second, owner, 'Browser Span Lane Two')

    await openSignedInApp(page)

    const directory = await fetchFromPage<DirectoryPage>(page, '/api/v1/account/agents')
    const inbox = await fetchFromPage<InboxPage>(page, '/api/v1/account/conversations')
    const directoryIds = directory.body.agents.map(({ id }) => id)
    const inboxIds = inbox.body.conversations.map(({ id }) => id)
    expect(directoryIds).toContain(firstAgent.id)
    expect(directoryIds).toContain(secondAgent.id)
    expect(inboxIds).toContain(firstConversation.id)
    expect(inboxIds).toContain(secondConversation.id)

    // The account space has no workspace parameter: scoping by workspace is a
    // client error, and without one the answers are stable across repeated
    // fetches — switching workspaces cannot change them.
    const scoped = await fetchFromPage(page, `/api/v1/account/agents?workspaceId=${first}`)
    expect(scoped.status).toBe(400)
    expect(scoped.body).toEqual({ code: 'invalid_request', message: 'Invalid request' })
    expect(await fetchFromPage<DirectoryPage>(page, '/api/v1/account/agents')).toEqual(directory)
    expect(await fetchFromPage<InboxPage>(page, '/api/v1/account/conversations')).toEqual(inbox)
  })

  test('unread changes surface after a connection drop and reconnect', async ({
    page,
    context,
  }) => {
    test.slow()
    const owner = await signIn(context)
    const workspaceId = await seedWorkspace(owner, 'Browser Reconnect HQ')
    // The poster is a workspace member and channel participant, like the
    // route-flow suite's reader: only participants can post into the lane.
    const poster = await backgroundUser('browser-poster')
    await addWorkspaceMembership(connection.db, workspaceId, poster, 'member')
    const conversation = await seedConversation(workspaceId, owner, 'Browser Reconnect Lane', [
      owner,
      poster,
    ])

    await openSignedInApp(page)
    const inboxPath = '/api/v1/account/conversations'
    const before = await fetchFromPage<InboxPage>(page, inboxPath)
    expect(before.body.conversations.find((row) => row.id === conversation.id)).toMatchObject({
      unread: false,
      topLevelUnreadCount: 0,
    })

    // The connection drops: the browser's own fetch cannot reach the route.
    await context.setOffline(true)
    const dropped = await page.evaluate(async (path) => {
      try {
        await fetch(path)
        return false
      } catch {
        return true
      }
    }, inboxPath)
    expect(dropped).toBe(true)

    // While disconnected, activity lands (written through the restricted
    // Postgres fixture pattern, exactly like the route-flow suite).
    await seedMessage(workspaceId, conversation.id, poster)

    // Reconnect: the refetch answers fresh — no stale cached copy survives the
    // drop, because every account response is `private, no-store`.
    await context.setOffline(false)
    const after = await fetchFromPage<InboxPage>(page, inboxPath)
    expect(after.cacheControl).toBe('private, no-store')
    expect(after.body.conversations.find((row) => row.id === conversation.id)).toMatchObject({
      unread: true,
      topLevelUnreadCount: 1,
    })
    const deepLink = await fetchFromPage<{ conversation: { unread: boolean } }>(
      page,
      `/api/v1/account/conversations/${conversation.id}`
    )
    expect(deepLink.body.conversation.unread).toBe(true)

    // Reading settles the unread state through the same route.
    await markChannelReadState(
      connection.db,
      workspaceId,
      conversation.id,
      owner,
      'read',
      after.body.conversations.find((row) => row.id === conversation.id)!.latestTopLevelSequence
    )
    const settled = await fetchFromPage<InboxPage>(page, inboxPath)
    expect(settled.body.conversations.find((row) => row.id === conversation.id)).toMatchObject({
      unread: false,
      topLevelUnreadCount: 0,
    })
  })

  test('a session revoked while disconnected is fenced after reconnect', async ({
    page,
    context,
  }) => {
    test.slow()
    const owner = await signIn(context)
    const workspaceId = await seedWorkspace(owner, 'Browser Fencing HQ')
    const agent = await seedAgent(workspaceId, owner, 'Browser Fencing Agent')
    const conversation = await seedConversation(workspaceId, owner, 'Browser Fencing Lane')

    await openSignedInApp(page)
    expect((await fetchFromPage<DirectoryPage>(page, '/api/v1/account/agents')).status).toBe(200)

    // Disconnected: the session is revoked server-side (the expiry/rotation
    // path — the credential row disappears while the cookie is still in the
    // browser's jar).
    await context.setOffline(true)
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, owner.userId))
    await context.setOffline(false)

    // The stale cookie's requests are fenced with exactly the unauthenticated
    // answer — status, body and privacy header all match a no-cookie request.
    const fenced = await fetchFromPage(page, '/api/v1/account/agents')
    expect(fenced.status).toBe(401)
    expect(fenced.body).toEqual(UNAUTHENTICATED_BODY)
    expect(fenced.cacheControl).toBe('private, no-store')
    const fencedInbox = await fetchFromPage(page, '/api/v1/account/conversations')
    expect(fencedInbox.body).toEqual(UNAUTHENTICATED_BODY)
    const fencedAgent = await fetchFromPage(page, `/api/v1/account/agents/${agent.id}`)
    expect(fencedAgent.body).toEqual(UNAUTHENTICATED_BODY)
    const fencedConversation = await fetchFromPage(
      page,
      `/api/v1/account/conversations/${conversation.id}`
    )
    expect(fencedConversation.body).toEqual(UNAUTHENTICATED_BODY)

    // The app itself recovers: reloading re-signs the browser in as a fresh
    // guest through the real bootstrap and renders the workspace shell again.
    await page.reload()
    await expect(page.getByRole('button', { name: 'User settings' })).toBeVisible({
      timeout: 20_000,
    })
    const fresh = await context.request.post('/api/workspaces/bootstrap')
    expect(fresh.status()).toBe(200)
    const freshPayload = (await fresh.json()) as {
      principal: { userId: string; temporary: boolean }
      sessionRotated: boolean
      workspaces: { id: string }[]
    }
    expect(freshPayload.principal.temporary).toBe(true)
    expect(freshPayload.principal.userId).not.toBe(owner.userId)
    for (const workspace of freshPayload.workspaces) workspaceIds.push(workspace.id)
    userIds.push(freshPayload.principal.userId)
  })
})
