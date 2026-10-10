// Route → PostgreSQL flows for grant-gated group channels (#1178).
//
// Coverage class: real product route modules, real handlers, real database,
// real @adea-ai/db group decisions. Two seams are injected, in the same way as
// account-directory-routes.test.ts:
//   - `@tanstack/solid-router` is replaced with an identity `createFileRoute`,
//     so the route modules load under bun. The handlers are the production
//     functions, reached through `Route.server.handlers`.
//   - `resolveWorkspacePrincipal` reads the caller from an `x-test-user-id`
//     header instead of a session cookie. Session minting is covered elsewhere.
// Revocation has no route in this repo, so group grants are revoked through the
// production `revokeGroupGrant` function, not an HTTP call.
//
// Runs under `bun run test:integration` (react-server condition required):
//   DATABASE_URL=... DATABASE_URL_UNPOOLED=... DATABASE_MIGRATION_URL=... \
//     bun test --conditions=react-server --timeout 60000 \
//     apps/web/test/integration/group-channel-routes.test.ts

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

import {
  addWorkspaceMembership,
  createAgent,
  createDatabase,
  createMessage,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  messages,
  revokeGroupGrant,
  channels,
  type DatabaseConnection,
  type UserPrincipalRef,
} from '@adea-ai/db'

const connectionUrl = process.env.DATABASE_URL

if (!connectionUrl) {
  // A missing database fails the lane; a silent skip would hide every route flow.
  throw new Error(
    'DATABASE_URL is required for the group route lane: run it through `bun run test:integration`'
  )
}

mock.module('@tanstack/solid-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}))

mock.module('../../src/server/workspace-principal', () => ({
  resolveWorkspacePrincipal: async (request: Request) => {
    const userId = request.headers.get('x-test-user-id')
    if (!userId) return null
    return {
      clearTemporaryCredential: false,
      principal: { kind: 'user' as const, userId },
      sessionRotated: false,
      temporary: true,
    }
  },
}))

type Handler = (input: { request: Request; params: Record<string, string> }) => Promise<Response>
type RouteModule = { server: { handlers: Record<'GET' | 'POST' | 'PATCH', Handler> } }

const ISSUED = '2026-10-01T00:00:00.000Z'

function audienceGrant(groupId: string, participant: UserPrincipalRef, grantId: string) {
  return {
    expiresAt: null,
    grantId,
    groupId,
    issuedAt: ISSUED,
    participant: { kind: 'user', userId: participant.userId },
    revision: 1,
    revokedAt: null,
  }
}

function enlistmentGrant(groupId: string, agentId: string, workspaceId: string, grantId: string) {
  return {
    agent: { agentId, workspaceId },
    expiresAt: null,
    grantId,
    groupId,
    issuedAt: ISSUED,
    revision: 1,
    revokedAt: null,
  }
}

describe.skipIf(!connectionUrl)('grant-gated group channels: product routes', () => {
  let connection: DatabaseConnection
  let channelsRoute: RouteModule
  let messagesRoute: RouteModule
  let participantsRoute: RouteModule
  let messageByIdRoute: RouteModule

  beforeAll(async () => {
    connection = createDatabase(connectionUrl!)
    channelsRoute = (await import('../../src/start/routes/api/v1/workspaces/$workspaceId/channels'))
      .Route as unknown as RouteModule
    messagesRoute = (
      await import('../../src/start/routes/api/v1/workspaces/$workspaceId/channels/$channelId/messages')
    ).Route as unknown as RouteModule
    participantsRoute = (
      await import('../../src/start/routes/api/v1/workspaces/$workspaceId/channels/$channelId/participants')
    ).Route as unknown as RouteModule
    messageByIdRoute = (
      await import('../../src/start/routes/api/v1/workspaces/$workspaceId/messages/$messageId')
    ).Route as unknown as RouteModule
  })

  afterAll(async () => connection.close())

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `group-routes-${label}-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).principal
  }

  async function fixture() {
    const owner = await user('owner')
    const member = await user('member')
    const outsider = await user('outsider')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: randomUUID(),
      name: 'Group routes',
      owner,
    })
    // Granted writers are admins: the route pre-gate (authorizeConversationWrite)
    // admits workspace.update or project editors only. See the known-gap test.
    await addWorkspaceMembership(connection.db, workspace.id, member, 'admin')
    const plain = await user('plain')
    await addWorkspaceMembership(connection.db, workspace.id, plain, 'member')
    const agent = await createAgent(connection.db, workspace.id, owner, {
      name: 'Scribe',
      profileId: 'lead',
      profileVersion: '1',
    })
    return { agent, member, outsider, owner, plain, workspace }
  }

  function call(
    route: RouteModule,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    params: Record<string, string>,
    options: {
      as?: UserPrincipalRef
      body?: unknown
      idempotencyKey?: string
      ifMatch?: number
    } = {}
  ): Promise<Response> {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (options.as) headers.set('x-test-user-id', options.as.userId)
    if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey)
    if (options.ifMatch) headers.set('if-match', String(options.ifMatch))
    const request = new Request(`http://localhost${url}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    return route.server.handlers[method]({ request, params })
  }

  async function createGroup(
    f: Awaited<ReturnType<typeof fixture>>,
    grants: { audience?: UserPrincipalRef[]; agent?: boolean } = {}
  ) {
    const channelId = randomUUID()
    const response = await call(
      channelsRoute,
      'POST',
      `/api/v1/workspaces/${f.workspace.id}/channels`,
      { workspaceId: f.workspace.id },
      {
        as: f.owner,
        idempotencyKey: randomUUID(),
        body: {
          kind: 'group',
          title: 'Group',
          channelId,
          audienceGrants: (grants.audience ?? []).map((participant, index) =>
            audienceGrant(channelId, participant, `gra_aud_${index}_${channelId}`)
          ),
          enlistmentGrants: grants.agent
            ? [enlistmentGrant(channelId, f.agent.id, f.workspace.id, `gra_agent_${channelId}`)]
            : [],
        },
      }
    )
    return { channelId, response }
  }

  function messagesUrl(f: Awaited<ReturnType<typeof fixture>>, channelId: string) {
    return `/api/v1/workspaces/${f.workspace.id}/channels/${channelId}/messages`
  }

  async function postText(
    f: Awaited<ReturnType<typeof fixture>>,
    channelId: string,
    as: UserPrincipalRef,
    bodyText: string
  ) {
    return call(
      messagesRoute,
      'POST',
      messagesUrl(f, channelId),
      {
        workspaceId: f.workspace.id,
        channelId,
      },
      { as, idempotencyKey: randomUUID(), body: { bodyText } }
    )
  }

  async function readTexts(
    f: Awaited<ReturnType<typeof fixture>>,
    channelId: string,
    as: UserPrincipalRef
  ): Promise<string[]> {
    const response = await call(
      messagesRoute,
      'GET',
      messagesUrl(f, channelId),
      {
        workspaceId: f.workspace.id,
        channelId,
      },
      { as }
    )
    expect(response.status).toBe(200)
    const page = (await response.json()) as { messages: { bodyText?: string | null }[] }
    return page.messages.map((message) => message.bodyText ?? '')
  }

  async function countMessages(channelId: string, bodyText: string): Promise<number> {
    const rows = await connection.db
      .select({ bodyText: messages.bodyText })
      .from(messages)
      .where(eq(messages.channelId, channelId))
    return rows.filter((row) => row.bodyText === bodyText).length
  }

  test('canonical grants create a group over the route and the granted member reads and posts', async () => {
    const f = await fixture()
    const { channelId, response } = await createGroup(f, { audience: [f.member], agent: true })
    expect(response.status).toBe(201)
    const created = (await response.json()) as { channel: { id: string; kind: string } }
    expect(created.channel).toMatchObject({ id: channelId, kind: 'group' })

    const posted = await postText(f, channelId, f.member, 'member hello')
    expect(posted.status).toBe(201)
    expect(await readTexts(f, channelId, f.member)).toContain('member hello')
    expect(await readTexts(f, channelId, f.owner)).toContain('member hello')
  })

  test('a grant whose group does not match the channel is refused with zero writes', async () => {
    const f = await fixture()
    const channelId = randomUUID()
    const response = await call(
      channelsRoute,
      'POST',
      `/api/v1/workspaces/${f.workspace.id}/channels`,
      { workspaceId: f.workspace.id },
      {
        as: f.owner,
        idempotencyKey: randomUUID(),
        body: {
          kind: 'group',
          title: 'Mismatched',
          channelId,
          audienceGrants: [audienceGrant(randomUUID(), f.member, 'gra_wrong_group')],
        },
      }
    )
    expect(response.status).toBe(400)
    const rows = await connection.db.select().from(channels).where(eq(channels.id, channelId))
    expect(rows).toHaveLength(0)
  })

  test('join point over routes: a newcomer reads nothing before joining and everything after', async () => {
    const f = await fixture()
    const { channelId, response } = await createGroup(f, { agent: true })
    expect(response.status).toBe(201)
    const created = (await response.json()) as { channel: { version: number } }
    await postText(f, channelId, f.owner, 'before the newcomer')

    const joined = await joinMember(f, channelId, created.channel.version, f.member, 'gra_join')
    expect(joined.status).toBe(200)

    expect(await readTexts(f, channelId, f.member)).not.toContain('before the newcomer')
    const after = await postText(f, channelId, f.owner, 'after the newcomer')
    expect(after.status).toBe(201)
    expect(await readTexts(f, channelId, f.member)).toContain('after the newcomer')
  })

  test('a revoked member reads nothing and a refused write persists nothing', async () => {
    const f = await fixture()
    const { channelId } = await createGroup(f, { audience: [f.member] })
    await postText(f, channelId, f.owner, 'visible before revocation')
    expect(await readTexts(f, channelId, f.member)).toContain('visible before revocation')

    const revoked = await revokeGroupGrant(connection.db, f.workspace.id, channelId, f.owner, {
      grantId: `gra_aud_0_${channelId}`,
      kind: 'audience',
      revokedAt: new Date().toISOString(),
    })
    expect(revoked).toEqual({ revoked: true })

    // Fail-closed reads return an empty page rather than an error: history
    // is withheld, not the channel's existence.
    expect(await readTexts(f, channelId, f.member)).toEqual([])

    const write = await postText(f, channelId, f.member, 'revoked write')
    expect(write.status).toBeGreaterThanOrEqual(400)
    expect(write.status).toBeLessThan(500)
    expect(await countMessages(channelId, 'revoked write')).toBe(0)
  })

  test('a foreign principal (not a workspace member) is refused on read and write with zero writes', async () => {
    const f = await fixture()
    const { channelId } = await createGroup(f, { audience: [f.member] })
    await postText(f, channelId, f.owner, 'members only')

    const read = await call(
      messagesRoute,
      'GET',
      messagesUrl(f, channelId),
      {
        workspaceId: f.workspace.id,
        channelId,
      },
      { as: f.outsider }
    )
    expect(read.status).toBe(404)
    expect(await read.json()).toMatchObject({ code: 'workspace_unavailable' })

    const write = await postText(f, channelId, f.outsider, 'intruder write')
    expect(write.status).toBe(404)
    expect(await countMessages(channelId, 'intruder write')).toBe(0)
  })

  test('KNOWN GAP: a granted plain workspace member is refused by the route pre-gate on write', async () => {
    // Pins the current behaviour so the gap stays visible. authorizeConversationWrite
    // admits workspace.update or project editors only, before the group fence runs.
    // Flip to expect(201) once that pre-gate admits live group grants.
    const f = await fixture()
    const { channelId } = await createGroup(f, { audience: [f.plain] })
    const write = await postText(f, channelId, f.plain, 'plain member write')
    expect(write.status).toBe(404)
    expect(await countMessages(channelId, 'plain member write')).toBe(0)
  })

  test('group message by id: a held pre-join message is refused, a granted one is served', async () => {
    const f = await fixture()
    const { channelId, response } = await createGroup(f, { agent: true })
    const created = (await response.json()) as { channel: { version: number } }
    const heldMessage = await createMessage(connection.db, f.workspace.id, channelId, f.owner, {
      bodyText: 'held pre-join',
      idempotencyKey: randomUUID(),
      sender: f.owner,
    })

    const joined = await joinMember(f, channelId, created.channel.version, f.member, 'gra_byid')
    expect(joined.status).toBe(200)

    const held = await call(
      messageByIdRoute,
      'GET',
      `/api/v1/workspaces/${f.workspace.id}/messages/${heldMessage.id}`,
      { workspaceId: f.workspace.id, messageId: heldMessage.id },
      { as: f.member }
    )
    expect(held.status).toBeGreaterThanOrEqual(400)
    expect(held.status).toBeLessThan(500)

    const posted = await postText(f, channelId, f.owner, 'granted after join')
    const postedBody = (await posted.json()) as { message: { id: string } }
    const granted = await call(
      messageByIdRoute,
      'GET',
      `/api/v1/workspaces/${f.workspace.id}/messages/${postedBody.message.id}`,
      { workspaceId: f.workspace.id, messageId: postedBody.message.id },
      { as: f.member }
    )
    expect(granted.status).toBe(200)
  })

  function joinMember(
    f: Awaited<ReturnType<typeof fixture>>,
    channelId: string,
    version: number,
    member: UserPrincipalRef,
    grantId: string
  ) {
    return call(
      participantsRoute,
      'POST',
      `/api/v1/workspaces/${f.workspace.id}/channels/${channelId}/participants`,
      { workspaceId: f.workspace.id, channelId },
      {
        as: f.owner,
        ifMatch: version,
        body: {
          // The replacement roster lists every member, the creator included.
          participants: [f.owner, member].map((principal) => ({
            kind: 'user',
            userId: principal.userId,
          })),
          // Replacement is total: the founder's grant is restated too.
          audienceGrants: [
            audienceGrant(channelId, f.owner, `founder-${f.owner.userId}`),
            audienceGrant(channelId, member, `${grantId}_${channelId}`),
          ],
          enlistmentGrants: [],
        },
      }
    )
  }
})
