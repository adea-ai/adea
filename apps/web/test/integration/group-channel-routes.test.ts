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
  createDatabase,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  messages,
  removeWorkspaceMembership,
  revokeGroupGrant,
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

describe.skipIf(!connectionUrl)('grant-gated group channels: product routes', () => {
  let connection: DatabaseConnection
  let channelsRoute: RouteModule
  let messagesRoute: RouteModule

  beforeAll(async () => {
    connection = createDatabase(connectionUrl!)
    channelsRoute = (await import('../../src/start/routes/api/v1/workspaces/$workspaceId/channels'))
      .Route as unknown as RouteModule
    messagesRoute = (
      await import('../../src/start/routes/api/v1/workspaces/$workspaceId/channels/$channelId/messages')
    ).Route as unknown as RouteModule
  })

  afterAll(async () => connection?.close())

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
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: randomUUID(),
      name: 'Group routes',
      owner,
    })
    await addWorkspaceMembership(connection.db, workspace.id, member, 'admin')
    const plain = await user('plain')
    await addWorkspaceMembership(connection.db, workspace.id, plain, 'member')
    return { member, owner, plain, workspace }
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
    grants: { audience?: UserPrincipalRef[] } = {}
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
          enlistmentGrants: [],
        },
      }
    )
    expect(response.status).toBe(201)
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

  test('a granted plain workspace member writes to the group and reads it back', async () => {
    // Plain `member` role: no workspace.update, no project editorship. The live
    // canonical audience grant is the write authority for this group channel.
    const f = await fixture()
    const { channelId } = await createGroup(f, { audience: [f.plain] })
    const write = await postText(f, channelId, f.plain, 'plain member write')
    expect(write.status).toBe(201)
    expect(await countMessages(channelId, 'plain member write')).toBe(1)
    expect(await readTexts(f, channelId, f.owner)).toContain('plain member write')
  })

  test('a plain workspace member without a group grant is refused on write with zero writes', async () => {
    const f = await fixture()
    const { channelId } = await createGroup(f, { audience: [f.member] })
    const write = await postText(f, channelId, f.plain, 'ungranted plain write')
    expect(write.status).toBe(404)
    expect(await countMessages(channelId, 'ungranted plain write')).toBe(0)
  })

  test('a plain member whose group grant is revoked is refused on write with zero writes', async () => {
    const f = await fixture()
    const { channelId } = await createGroup(f, { audience: [f.plain] })
    const revoked = await revokeGroupGrant(connection.db, f.workspace.id, channelId, f.owner, {
      grantId: `gra_aud_0_${channelId}`,
      kind: 'audience',
      revokedAt: new Date().toISOString(),
    })
    expect(revoked).toEqual({ revoked: true })
    const write = await postText(f, channelId, f.plain, 'revoked plain write')
    expect(write.status).toBe(404)
    expect(await countMessages(channelId, 'revoked plain write')).toBe(0)
  })

  test('a granted principal whose workspace membership was removed is refused on write', async () => {
    // Membership is the separately required capability: the live grant does not
    // survive removal from the owning workspace.
    const f = await fixture()
    const { channelId } = await createGroup(f, { audience: [f.plain] })
    expect(await removeWorkspaceMembership(connection.db, f.workspace.id, f.plain)).toBe(true)
    const write = await postText(f, channelId, f.plain, 'removed member write')
    expect(write.status).toBe(404)
    expect(await countMessages(channelId, 'removed member write')).toBe(0)
  })
})
