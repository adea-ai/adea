// Route → PostgreSQL → client flows for the account-wide directory and inbox
// wiring (M11.03, stacked on #1194's query layer).
//
// Lane: a normal part of `bun run test:integration`. The runner discovers this
// directory, provisions the repo's restricted local Postgres when no
// DATABASE_URL is exported (or requires the full
// DATABASE_URL / DATABASE_URL_UNPOOLED / DATABASE_MIGRATION_URL trio when one
// is), and invokes this file with the react-server export condition, which the
// route handlers' `server-only` marker requires. Missing database configuration
// fails the lane; it never skips it. To iterate on one file, reproduce the
// runner's invocation:
//
//   DATABASE_URL=... DATABASE_URL_UNPOOLED=... \
//     bun test --conditions=react-server --timeout 30000 \
//     apps/web/test/integration
//
// What bun can and cannot load here (probed): the route modules under
// src/start/routes/api/v1/account and the real `resolveWorkspacePrincipal`
// both transitively import `@tanstack/solid-router`, whose module scope uses
// the solid-js/web client runtime — without the bundler's solid aliasing it
// throws at import time even under react-server conditions. Those stay pinned
// textually by scripts/account-directory-route-boundary.test.ts. Everything
// else of the boundary is exercised for real below: the desktop request guard,
// the principal gate shape, `withRequestScope` request cleanup, the exported
// account*Response request handlers, the application database and the real
// @adea-ai/db queries, driven by the public @adea-ai/api-client.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'

import {
  accountAgentDirectory,
  accountConversationInbox,
  addWorkspaceMembership,
  agents,
  channelParticipants,
  channelReadStates,
  channels,
  createAgent,
  createDatabase,
  createGroupChannel,
  createMessage,
  createProject,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  findAccountAgent,
  findAccountConversation,
  markChannelReadState,
  messageMentions,
  messages,
  projects,
  removeWorkspaceMembership,
  setChannelParticipants,
  setProjectVisibility,
  temporaryUserSessions,
  threadReadStates,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
  type DatabaseConnection,
  type UserPrincipalRef,
} from '@adea-ai/db'
import { AccountDirectoryApiClient } from '@adea-ai/api-client/account-directory'
import { ApiClientError } from '@adea-ai/api-client'
import type { WorkspacePrincipalResolution } from '../../src/server/workspace-principal'
import type {
  AccountAgentLookup,
  AccountConversationLookup,
} from '../../src/server/account-directory-request'

const connectionUrl = process.env.DATABASE_URL

if (!connectionUrl) {
  // A missing database configuration fails the lane; a silent skip would turn
  // the whole route-flow lane green without exercising a single request.
  throw new Error(
    'DATABASE_URL is required for the account route-flow lane: run it through `bun run test:integration` (which provisions the restricted local Postgres or requires the DATABASE_URL / DATABASE_URL_UNPOOLED / DATABASE_MIGRATION_URL trio)'
  )
}

function resolutionFor(principal: UserPrincipalRef): WorkspacePrincipalResolution {
  return Object.freeze({
    clearTemporaryCredential: false,
    principal: Object.freeze({ kind: 'user' as const, userId: principal.userId }),
    sessionRotated: false,
    temporary: true,
  })
}
describe('account directory and inbox routes', () => {
  let connection: DatabaseConnection
  const workspaceIds: string[] = []
  const userIds: string[] = []
  /** The caller the dispatcher's routes resolve for the current request. */
  let caller: WorkspacePrincipalResolution | null = null
  const sentRequests: Request[] = []

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    const db = connection.db
    if (workspaceIds.length) {
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

  async function user(label: string): Promise<UserPrincipalRef> {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: `routes-${label}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 300_000),
    })
    userIds.push(session.principal.userId)
    return session.principal
  }

  async function workspace(owner: UserPrincipalRef, name: string) {
    const { workspace: created } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `routes-${crypto.randomUUID()}`,
      name,
      owner,
    })
    workspaceIds.push(created.id)
    return created.id
  }

  async function currentChannelVersion(workspaceId: string, channelId: string) {
    const [row] = await connection.db
      .select({ version: channels.version })
      .from(channels)
      .where(and(eq(channels.workspaceId, workspaceId), eq(channels.id, channelId)))
    return row!.version
  }

  async function groupConversation(
    workspaceId: string,
    owner: UserPrincipalRef,
    title: string,
    participants: readonly UserPrincipalRef[] = []
  ) {
    const channel = await createGroupChannel(connection.db, workspaceId, owner, {
      idempotencyKey: `routes-${crypto.randomUUID()}`,
      title,
    })
    if (participants.length)
      await setChannelParticipants(
        connection.db,
        workspaceId,
        channel.id,
        owner,
        participants.map((participant) => ({
          kind: 'user' as const,
          userId: participant.userId,
        })),
        channel.version
      )
    return channel
  }

  function post(workspaceId: string, channelId: string, sender: UserPrincipalRef) {
    return createMessage(connection.db, workspaceId, channelId, sender, {
      bodyText: 'route fixture',
      idempotencyKey: crypto.randomUUID(),
      sender,
    })
  }

  /**
   * The four route files' wiring, minus the `createFileRoute` registration:
   * exactly like the registered handlers, the request runs inside the real
   * `withRequestScope` (so the per-request application database is closed when
   * the response is produced), then the guard, then the principal gate, then
   * exactly one injected handler call. scripts/account-directory-route-boundary
   * .test.ts pins the route files to this same sequence. Tests may override the
   * injected lookup — the handlers' own dependency seam — to stage a state
   * change at an exact point inside the real handler.
   */
  async function dispatch(
    request: Request,
    overrides: Readonly<{
      agentLookup?: AccountAgentLookup
      conversationLookup?: AccountConversationLookup
    }> = {}
  ): Promise<Response> {
    const { guardDesktopWorkspaceRequest } = await import('../../src/server/desktop-workspace')
    const { applicationDatabase } = await import('../../src/server/database')
    const { withRequestScope } = await import('../../src/server/request-scope')
    const { workspaceUnavailableResponse } = await import('../../src/server/workspace-response')
    const {
      accountAgentDirectoryResponse,
      accountAgentLookupResponse,
      accountConversationInboxResponse,
      accountConversationLookupResponse,
    } = await import('../../src/server/account-directory-request')

    return withRequestScope(async () => {
      const rejected = guardDesktopWorkspaceRequest(request)
      if (rejected) return rejected
      if (!caller) return workspaceUnavailableResponse(request, 401)
      const database = applicationDatabase()
      const path = new URL(request.url).pathname
      if (path === '/api/v1/account/agents')
        return accountAgentDirectoryResponse(request, database, caller, accountAgentDirectory)
      if (path === '/api/v1/account/conversations')
        return accountConversationInboxResponse(request, database, caller, accountConversationInbox)
      const agentId = /^\/api\/v1\/account\/agents\/([^/]+)$/u.exec(path)?.[1]
      if (agentId)
        return accountAgentLookupResponse(
          request,
          database,
          caller,
          overrides.agentLookup ?? findAccountAgent,
          decodeURIComponent(agentId)
        )
      const conversationId = /^\/api\/v1\/account\/conversations\/([^/]+)$/u.exec(path)?.[1]
      if (conversationId)
        return accountConversationLookupResponse(
          request,
          database,
          caller,
          overrides.conversationLookup ?? findAccountConversation,
          decodeURIComponent(conversationId)
        )
      return new Response('not found', { status: 404 })
    })
  }

  /** The public client against the real route handlers and database. */
  function routeClient(): AccountDirectoryApiClient {
    sentRequests.length = 0
    return new AccountDirectoryApiClient({
      baseUrl: 'https://adea.test/api',
      fetchImpl: async (input, init) => {
        const request = new Request(input, init)
        sentRequests.push(request)
        return dispatch(request)
      },
    })
  }

  test('pagination walks every directory page through the real route', async () => {
    const owner = await user('page-owner')
    const workspaceId = await workspace(owner, 'Route Paging HQ')
    for (const name of ['Route Agent 01', 'Route Agent 02', 'Route Agent 03', 'Route Agent 04']) {
      await createAgent(connection.db, workspaceId, owner, {
        name,
        profileId: `prf_${'0'.repeat(25)}1`,
        profileVersion: `pfv_${'0'.repeat(25)}1`,
      })
    }
    caller = resolutionFor(owner)
    const client = routeClient()

    const full = await client.accountAgentDirectory()
    expect(full.agents.map(({ name }) => name).toSorted()).toEqual([
      'Route Agent 01',
      'Route Agent 02',
      'Route Agent 03',
      'Route Agent 04',
    ])

    // Page through the real route with the client's own cursor round trips.
    const seen: string[] = []
    const cursors: string[] = []
    let after: string | undefined
    let pages = 0
    do {
      const page = await client.accountAgentDirectory({ after, limit: 3 })
      expect(page.agents.length).toBeLessThanOrEqual(3)
      seen.push(...page.agents.map(({ id }) => id))
      after = page.nextCursor
      if (after) cursors.push(after)
      pages += 1
      expect(pages).toBeLessThan(10)
    } while (after)
    expect(pages).toBe(2)
    expect(seen).toHaveLength(full.agents.length)
    expect(seen.toSorted()).toEqual(full.agents.map(({ id }) => id).toSorted())
    expect(new Set(seen).size).toBe(seen.length)
    expect(new URL(sentRequests[1]!.url).search).toBe('?limit=3')
    expect(new URL(sentRequests[2]!.url).search).toBe(`?after=${cursors[0]}&limit=3`)
    // Every response is private and unindexed, like every account route.
    for (const request of sentRequests) {
      const response = await dispatch(request)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
    }
  })

  test('inbox pagination crosses pages without repeating a conversation', async () => {
    const owner = await user('inbox-pager')
    const workspaceId = await workspace(owner, 'Route Inbox Paging')
    const lanes: string[] = []
    for (const title of ['Route Lane A', 'Route Lane B', 'Route Lane C']) {
      const channel = await createGroupChannel(connection.db, workspaceId, owner, {
        idempotencyKey: `routes-${crypto.randomUUID()}`,
        title,
      })
      lanes.push(channel.id)
      await post(workspaceId, channel.id, owner)
    }
    // Distinct microsecond instants keep the walk deterministic.
    const instants = [
      `timestamptz '2026-10-08 09:00:00.000001+00'`,
      `timestamptz '2026-10-08 09:00:00.000002+00'`,
      `timestamptz '2026-10-08 09:00:00.000003+00'`,
    ]
    for (const [index, lane] of lanes.entries())
      await connection.db
        .update(channels)
        .set({ updatedAt: sql.raw(instants[index]!) })
        .where(eq(channels.id, lane))

    caller = resolutionFor(owner)
    const client = routeClient()
    const seen: string[] = []
    let after: string | undefined
    do {
      const page = await client.accountConversationInbox({ after, limit: 2 })
      seen.push(...page.conversations.map(({ id }) => id))
      after = page.nextCursor
    } while (after)
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
    expect(seen.toSorted()).toEqual(lanes.toSorted())
  })

  test('a private conversation is readable for participants and absent for everyone else', async () => {
    const owner = await user('private-owner')
    const member = await user('private-member')
    const outsider = await user('private-outsider')
    const workspaceId = await workspace(owner, 'Route Private HQ')
    await addWorkspaceMembership(connection.db, workspaceId, member, 'member')
    await addWorkspaceMembership(connection.db, workspaceId, outsider, 'member')
    const conversation = await groupConversation(workspaceId, owner, 'Route Private Lane', [member])
    await post(workspaceId, conversation.id, member)

    // Participants see the conversation in the inbox and by deep link.
    caller = resolutionFor(member)
    const client = routeClient()
    const inbox = await client.accountConversationInbox()
    const entry = inbox.conversations.find(({ id }) => id === conversation.id)
    expect(entry).toMatchObject({ id: conversation.id, title: 'Route Private Lane' })
    const lookup = await client.accountConversation(conversation.id)
    expect(lookup.conversation.id).toBe(conversation.id)

    // A workspace member without participation gets the exact missing answer:
    // same 404 shape and status, and no title, counts or workspace id leak.
    caller = resolutionFor(outsider)
    const outsiderClient = routeClient()
    const outsiderInbox = await outsiderClient.accountConversationInbox()
    expect(outsiderInbox.conversations.some(({ id }) => id === conversation.id)).toBe(false)

    let leak: unknown
    try {
      await outsiderClient.accountConversation(conversation.id)
    } catch (error) {
      leak = error
    }
    expect(leak).toBeInstanceOf(ApiClientError)
    expect((leak as ApiClientError).status).toBe(404)
    const denied = await dispatch(
      new Request(`https://adea.test/api/v1/account/conversations/${conversation.id}`)
    )
    const missing = await dispatch(
      new Request(
        'https://adea.test/api/v1/account/conversations/30000000-0000-4000-8000-000000000009'
      )
    )
    expect(denied.status).toBe(missing.status)
    expect(await denied.text()).toBe(await missing.text())
  })

  test('revocation between requests turns prior deep links 404 exactly like missing ids', async () => {
    const owner = await user('revoke-owner')
    const guest = await user('revoke-guest')
    const workspaceId = await workspace(owner, 'Route Revocation HQ')
    await addWorkspaceMembership(connection.db, workspaceId, guest, 'member')
    const conversation = await groupConversation(workspaceId, owner, 'Route Revoked Lane', [guest])
    const agent = await createAgent(connection.db, workspaceId, owner, {
      name: 'Route Revoked Agent',
      profileId: `prf_${'0'.repeat(25)}1`,
      profileVersion: `pfv_${'0'.repeat(25)}1`,
    })

    caller = resolutionFor(guest)
    const client = routeClient()
    expect((await client.accountConversation(conversation.id)).conversation.id).toBe(
      conversation.id
    )
    expect((await client.accountAgent(agent.id)).agent.id).toBe(agent.id)

    // Participation is revoked between two requests: the same deep link now
    // answers the missing response, and the inbox entry disappears without a
    // trace.
    await setChannelParticipants(
      connection.db,
      workspaceId,
      conversation.id,
      owner,
      [{ kind: 'user', userId: owner.userId }],
      await currentChannelVersion(workspaceId, conversation.id)
    )
    const afterParticipation = await client.accountConversation(conversation.id).catch((e) => e)
    expect(afterParticipation).toBeInstanceOf(ApiClientError)
    expect(afterParticipation.status).toBe(404)
    expect(
      (await client.accountConversationInbox()).conversations.some(
        ({ id }) => id === conversation.id
      )
    ).toBe(false)

    // Membership revocation closes the directory too.
    await removeWorkspaceMembership(connection.db, workspaceId, guest)
    const afterMembership = await client.accountAgent(agent.id).catch((e) => e)
    expect(afterMembership).toBeInstanceOf(ApiClientError)
    expect(afterMembership.status).toBe(404)
    expect((await client.accountAgentDirectory()).agents.some(({ id }) => id === agent.id)).toBe(
      false
    )
  })

  test('a revocation that commits while the lookup request is in flight is honored by that request', async () => {
    const owner = await user('revoke-during-owner')
    const guest = await user('revoke-during-guest')
    const workspaceId = await workspace(owner, 'Route During-Request HQ')
    await addWorkspaceMembership(connection.db, workspaceId, guest, 'member')
    const conversation = await groupConversation(workspaceId, owner, 'Route During-Request Lane', [
      guest,
    ])

    caller = resolutionFor(guest)
    const client = routeClient()
    expect((await client.accountConversation(conversation.id)).conversation.id).toBe(
      conversation.id
    )

    // The revocation commits while the request is in flight — after the guard
    // and the principal gate, before the data read: the handlers inject their
    // lookup, so the override revokes first and then delegates to the real
    // query inside the real accountConversationLookupResponse. The SAME request
    // must answer the exact missing response; nothing between the principal
    // resolution and the row read may serve from an authorization snapshot.
    const missing = await dispatch(
      new Request(
        'https://adea.test/api/v1/account/conversations/30000000-0000-4000-8000-000000000009'
      )
    )
    let revocationCommitted = false
    const during = await dispatch(
      new Request(`https://adea.test/api/v1/account/conversations/${conversation.id}`),
      {
        conversationLookup: async (database, principal, conversationId) => {
          await setChannelParticipants(
            connection.db,
            workspaceId,
            conversation.id,
            owner,
            [{ kind: 'user', userId: owner.userId }],
            await currentChannelVersion(workspaceId, conversation.id)
          )
          revocationCommitted = true
          return findAccountConversation(database, principal, conversationId)
        },
      }
    )
    expect(revocationCommitted).toBe(true)
    expect(during.status).toBe(404)
    expect(during.status).toBe(missing.status)
    expect(await during.text()).toBe(await missing.text())
  })

  test('unread state moves with messages and read marks through the route', async () => {
    const owner = await user('unread-owner')
    const reader = await user('unread-reader')
    const workspaceId = await workspace(owner, 'Route Unread HQ')
    await addWorkspaceMembership(connection.db, workspaceId, reader, 'member')
    const conversation = await groupConversation(workspaceId, owner, 'Route Unread Lane', [
      owner,
      reader,
    ])

    caller = resolutionFor(owner)
    const client = routeClient()
    const before = (await client.accountConversationInbox()).conversations.find(
      ({ id }) => id === conversation.id
    )
    expect(before).toMatchObject({ unread: false, topLevelUnreadCount: 0 })

    await post(workspaceId, conversation.id, reader)

    const after = (await client.accountConversationInbox()).conversations.find(
      ({ id }) => id === conversation.id
    )
    expect(after).toMatchObject({ unread: true, topLevelUnreadCount: 1 })
    expect((await client.accountConversation(conversation.id)).conversation.unread).toBe(true)

    await markChannelReadState(
      connection.db,
      workspaceId,
      conversation.id,
      owner,
      'read',
      after!.latestTopLevelSequence
    )
    const settled = (await client.accountConversationInbox()).conversations.find(
      ({ id }) => id === conversation.id
    )
    expect(settled).toMatchObject({ unread: false, topLevelUnreadCount: 0 })
  })

  test('denied, malformed and missing lookups are the same private answer', async () => {
    const owner = await user('boundary-owner')
    const workspaceId = await workspace(owner, 'Route Boundary HQ')
    const hiddenProject = await createProject(connection.db, workspaceId, owner, {
      iconKey: 'research',
      name: 'Route Hidden Project',
    })
    await setProjectVisibility(connection.db, workspaceId, hiddenProject.id, owner, 'members')
    const hiddenAgent = await createAgent(connection.db, workspaceId, owner, {
      name: 'Route Hidden Agent',
      profileId: `prf_${'0'.repeat(25)}1`,
      profileVersion: `pfv_${'0'.repeat(25)}1`,
      projectId: hiddenProject.id,
    })

    const viewer = await user('boundary-viewer')
    await addWorkspaceMembership(connection.db, workspaceId, viewer, 'member')
    caller = resolutionFor(viewer)
    const client = routeClient()

    // A members-only project's Agent is denied; denial is indistinguishable
    // from a missing id.
    const deniedResponse = await dispatch(
      new Request(`https://adea.test/api/v1/account/agents/${hiddenAgent.id}`)
    )
    const missingResponse = await dispatch(
      new Request('https://adea.test/api/v1/account/agents/10000000-0000-4000-8000-000000000009')
    )
    expect(deniedResponse.status).toBe(404)
    expect(deniedResponse.status).toBe(missingResponse.status)
    const deniedBody = await deniedResponse.text()
    expect(deniedBody).toBe(await missingResponse.text())
    expect(deniedBody).not.toContain('Route Hidden Agent')
    expect(
      (await client.accountAgentDirectory()).agents.some(({ id }) => id === hiddenAgent.id)
    ).toBe(false)

    // Malformed ids and hostile cursors are rejected before the database.
    const malformed = await client.accountAgent('../../etc/passwd').catch((e) => e)
    expect(malformed).toBeInstanceOf(ApiClientError)
    expect(malformed.status).toBe(400)
    const hostileCursor = await client
      .accountAgentDirectory({ after: 'not base64url' })
      .catch((e) => e)
    expect(hostileCursor).toBeInstanceOf(ApiClientError)
    expect(hostileCursor.status).toBe(400)
  })

  test('an unmapped lookup failure answers 503 instead of a fake 404', async () => {
    const owner = await user('unmapped-owner')
    await workspace(owner, 'Route Unmapped HQ')
    caller = resolutionFor(owner)

    // An unexpected database failure is a server failure, not "missing": it
    // must not masquerade as the denied-equals-missing 404 answer.
    const response = await dispatch(
      new Request(
        'https://adea.test/api/v1/account/conversations/20000000-0000-4000-8000-000000000009'
      ),
      {
        conversationLookup: async () => {
          throw new Error('replica connection lost')
        },
      }
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      code: 'account_directory_unavailable',
      message: 'Directory unavailable',
    })
  })

  test('account routes answer the same regardless of any selected workspace', async () => {
    const owner = await user('switch-owner')
    const first = await workspace(owner, 'Route Switch One')
    const second = await workspace(owner, 'Route Switch Two')
    const firstAgent = await createAgent(connection.db, first, owner, {
      name: 'Route Switch Agent One',
      profileId: `prf_${'0'.repeat(25)}1`,
      profileVersion: `pfv_${'0'.repeat(25)}1`,
    })
    const secondAgent = await createAgent(connection.db, second, owner, {
      name: 'Route Switch Agent Two',
      profileId: `prf_${'0'.repeat(25)}1`,
      profileVersion: `pfv_${'0'.repeat(25)}1`,
    })
    const firstConversation = await groupConversation(first, owner, 'Route Switch Lane One')
    const secondConversation = await groupConversation(second, owner, 'Route Switch Lane Two')

    caller = resolutionFor(owner)
    const client = routeClient()

    // One page carries both workspaces' rows: the route has no workspace
    // parameter to vary, so "switching" cannot change the answer.
    const directory = await client.accountAgentDirectory()
    const directoryIds = directory.agents.map(({ id }) => id)
    expect(directoryIds).toContain(firstAgent.id)
    expect(directoryIds).toContain(secondAgent.id)
    const inbox = await client.accountConversationInbox()
    const inboxIds = inbox.conversations.map(({ id }) => id)
    expect(inboxIds).toContain(firstConversation.id)
    expect(inboxIds).toContain(secondConversation.id)

    // And the answers are stable across repeated calls.
    expect(await client.accountAgentDirectory()).toEqual(directory)
    expect(await client.accountConversationInbox()).toEqual(inbox)
    // Every request stayed account-scoped: no workspace id anywhere.
    for (const request of sentRequests) {
      expect(new URL(request.url).pathname).toMatch(/^\/api\/v1\/account\//u)
      expect(new URL(request.url).searchParams.get('workspaceId')).toBeNull()
    }
  })
})
