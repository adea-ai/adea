// Route → PostgreSQL flows for addressed group turns (#1179).
//
// Coverage class: real route modules, real handlers, real database, real durable coordinator. Two seams
// are injected, the same way as group-channel-routes.test.ts:
//   - `@tanstack/solid-router` is replaced with an identity `createFileRoute`, so the route modules load
//     under bun. The handlers are the production functions, reached through `Route.server.handlers`.
//   - `resolveWorkspacePrincipal` reads the caller from an `x-test-user-id` header instead of a session
//     cookie. Session minting is covered elsewhere.
//
// Runs under `bun run test:integration` (react-server condition required):
//   DATABASE_URL=... DATABASE_URL_UNPOOLED=... DATABASE_MIGRATION_URL=... \
//     bun test --conditions=react-server --timeout 60000 \
//     apps/web/test/integration/addressed-turn-routes.test.ts

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

import {
  addWorkspaceMembership,
  agents,
  addressedAgentTurns,
  channels,
  createAgent,
  createDatabase,
  createGroupChannelWithGrants,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  groupCreationCandidatesFromGrants,
  leadTurnIntents,
  loadAddressedTurns,
  postGroupChannelMessage,
  revokeGroupGrant,
  setGroupChannelParticipantsWithGrants,
  type DatabaseConnection,
  type UserPrincipalRef,
} from '@adea-ai/db'

const connectionUrl = process.env.DATABASE_URL

if (!connectionUrl) {
  // A missing database fails the lane; a silent skip would hide every route flow.
  throw new Error(
    'DATABASE_URL is required for the addressed-turn route lane: run it through `bun run test:integration`'
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
type RouteModule = { server: { handlers: Record<'GET' | 'POST', Handler> } }

const ISSUED = '2026-10-01T00:00:00.000Z'
const NOW = '2026-10-08T12:00:00.000Z'

function audienceGrant(groupId: string, participant: UserPrincipalRef, grantId: string) {
  return {
    expiresAt: null,
    grantId,
    groupId,
    issuedAt: ISSUED,
    participant,
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

describe.skipIf(!connectionUrl)('addressed group turns: product routes', () => {
  let connection: DatabaseConnection
  let turnsRoute: RouteModule
  let cancelRoute: RouteModule

  beforeAll(async () => {
    connection = createDatabase(connectionUrl!)
    turnsRoute = (
      await import('../../src/start/routes/api/v1/workspaces/$workspaceId/channels/$channelId/turns')
    ).Route as unknown as RouteModule
    cancelRoute = (
      await import('../../src/start/routes/api/v1/workspaces/$workspaceId/channels/$channelId/turns/$turnId/cancel')
    ).Route as unknown as RouteModule
  })

  afterAll(async () => connection?.close())

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `turn-routes-${label}-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 120_000),
      })
    ).principal
  }

  async function fixture() {
    const owner = await user('owner')
    const member = await user('member')
    const bystander = await user('bystander')
    const stranger = await user('stranger')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: randomUUID(),
      name: 'Turn routes',
      owner,
    })
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
    await addWorkspaceMembership(connection.db, workspace.id, bystander, 'member')
    const lead = await createAgent(connection.db, workspace.id, owner, {
      name: 'Lead',
      profileId: 'lead',
      profileVersion: '1',
    })
    await connection.db.update(agents).set({ isWorkspaceLead: true }).where(eq(agents.id, lead.id))
    const helper = await createAgent(connection.db, workspace.id, owner, {
      name: 'Helper',
      profileId: 'lead',
      profileVersion: '1',
    })
    const channelId = randomUUID()
    await createGroupChannelWithGrants(connection.db, workspace.id, owner, {
      candidates: groupCreationCandidatesFromGrants(workspace.id, {
        audienceGrants: [
          audienceGrant(channelId, owner, 'gra_owner'),
          audienceGrant(channelId, member, 'gra_member'),
        ],
        enlistmentGrants: [
          enlistmentGrant(channelId, lead.id, workspace.id, 'gra_lead'),
          enlistmentGrant(channelId, helper.id, workspace.id, 'gra_helper'),
        ],
      }),
      channelId,
      idempotencyKey: randomUUID(),
      now: NOW,
      title: 'Group',
    })
    const post = (sender: UserPrincipalRef, bodyText: string) =>
      postGroupChannelMessage(
        connection.db,
        workspace.id,
        channelId,
        sender,
        sender,
        { message: { bodyText, idempotencyKey: randomUUID() }, mode: 'direct' },
        { now: NOW }
      )
    const trigger = await post(owner, 'please answer')
    return { bystander, channelId, helper, lead, member, owner, post, stranger, trigger, workspace }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function call(
    route: RouteModule,
    method: 'GET' | 'POST',
    f: Fixture,
    path: string,
    options: { as?: UserPrincipalRef | null; body?: unknown; params?: Record<string, string> } = {}
  ): Promise<Response> {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (options.as) headers.set('x-test-user-id', options.as.userId)
    const raw =
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body)
    const request = new Request(
      `http://localhost/api/v1/workspaces/${f.workspace.id}/channels/${f.channelId}/turns${path}`,
      { headers, method, ...(raw === undefined ? {} : { body: raw }) }
    )
    return route.server.handlers[method]({
      params: { channelId: f.channelId, workspaceId: f.workspace.id, ...options.params },
      request,
    })
  }
  const address = (f: Fixture, body: unknown, as: UserPrincipalRef | null = f.owner) =>
    call(turnsRoute, 'POST', f, '', { as, body })
  const list = (f: Fixture, query = '', as: UserPrincipalRef | null = f.owner) =>
    call(turnsRoute, 'GET', f, query, { as })
  const cancel = (f: Fixture, turnId: string, as: UserPrincipalRef | null, body?: unknown) =>
    call(cancelRoute, 'POST', f, `/${turnId}/cancel`, {
      as,
      body: body ?? {},
      params: { turnId },
    })
  const request = (f: Fixture, agentId: string, dispatchRevision = 1) => ({
    agentId,
    dispatchRevision,
    triggerMessageId: f.trigger.id,
  })
  const claims = (f: Fixture) => loadAddressedTurns(connection.db, f.workspace.id, f.channelId)
  const intents = async (f: Fixture) =>
    (
      await connection.db
        .select({ id: leadTurnIntents.id })
        .from(leadTurnIntents)
        .where(eq(leadTurnIntents.workspaceId, f.workspace.id))
    ).length

  test('addresses the lead through the real handler, converges on repeat, and replays after a reconnect', async () => {
    const f = await fixture()
    const first = await address(f, request(f, f.lead.id))
    expect(first.status).toBe(201)
    expect(first.headers.get('cache-control')).toBe('private, no-store')
    const created = (await first.json()) as {
      created: boolean
      dispatch: string
      turn: Record<string, unknown>
    }
    expect(created).toMatchObject({
      created: true,
      dispatch: 'admitted',
      turn: {
        addressedLabel: `${f.workspace.id}:${f.lead.id}`,
        addresserUserId: f.owner.userId,
        agentId: f.lead.id,
        budget: { maxDepth: 2, maxTurns: 8 },
        causalId: `turn:${f.trigger.id}:${f.lead.id}:1`,
        dispatchRevision: 1,
        dispatched: true,
        state: 'dispatching',
        triggerMessageId: f.trigger.id,
      },
    })
    expect(created.turn.leadTurnIntentId).toBeString()
    // The same request again (a retry or a reconnect) converges: 200, the same turn, one claim, one intent.
    const again = await address(f, request(f, f.lead.id))
    expect(again.status).toBe(200)
    const converged = (await again.json()) as { created: boolean; turn: { id: string } }
    expect(converged.created).toBe(false)
    expect(converged.turn.id).toBe(created.turn.id)
    expect(await claims(f)).toHaveLength(1)
    expect(await intents(f)).toBe(1)
    // The reconnect read returns the retained turn with its attribution; only the addresser sees the intent.
    const replay = (await (await list(f, '', f.member)).json()) as {
      nextAfter: string | null
      turns: { id: string; addresserUserId: string; leadTurnIntentId: string | null }[]
    }
    expect(replay.turns.map((turn) => turn.id)).toEqual([created.turn.id])
    expect(replay.turns[0]?.addresserUserId).toBe(f.owner.userId)
    expect(replay.turns[0]?.leadTurnIntentId).toBeNull()
    expect(replay.nextAfter).toBeNull()
    const mine = (await (await list(f)).json()) as { turns: { leadTurnIntentId: string | null }[] }
    expect(mine.turns[0]?.leadTurnIntentId).toBe(created.turn.leadTurnIntentId as string)
  })

  test('a non-lead Agent is retained but never dispatched', async () => {
    const f = await fixture()
    const response = await address(f, request(f, f.helper.id))
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      created: true,
      dispatch: 'not_lead',
      turn: { dispatched: false, leadTurnIntentId: null, state: 'claimed' },
    })
    expect(await intents(f)).toBe(0)
  })

  test('the body is strict: the addresser and the budget cannot be named, and nothing is persisted', async () => {
    const f = await fixture()
    const base = request(f, f.lead.id)
    for (const body of [
      { ...base, addressedBy: { kind: 'user', userId: f.member.userId } },
      { ...base, budget: { maxDepth: 9, maxTurns: 99 } },
      { ...base, extra: true },
      { ...base, dispatchRevision: 0 },
      { ...base, dispatchRevision: 1.5 },
      { ...base, dispatchRevision: '1' },
      { ...base, agentId: 'not-a-uuid' },
      { ...base, triggerMessageId: undefined },
      { ...base, parentTurnId: 'nope' },
      [base],
      'not json{',
      { ...base, padding: 'x'.repeat(2048) },
    ]) {
      const response = await address(f, body)
      expect(response.status).toBe(400)
    }
    expect(await claims(f)).toHaveLength(0)
    expect(await intents(f)).toBe(0)
  })

  test('unauthenticated, unadmitted and cross-workspace callers all read as unavailable', async () => {
    const f = await fixture()
    expect((await address(f, request(f, f.lead.id), null)).status).toBe(401)
    for (const caller of [f.bystander, f.stranger]) {
      const response = await address(f, request(f, f.lead.id), caller)
      expect(response.status).toBe(404)
      const text = await response.text()
      expect(text).not.toContain(f.lead.id)
      expect(text).not.toContain(f.trigger.id)
      expect((await list(f, '', caller)).status).toBe(404)
    }
    expect(await claims(f)).toHaveLength(0)
    expect(await intents(f)).toBe(0)
  })

  test('a participant who did not write the trigger cannot address from it', async () => {
    const f = await fixture()
    const response = await address(f, request(f, f.helper.id), f.member)
    expect(response.status).toBe(404)
    expect(await claims(f)).toHaveLength(0)
  })

  test('revoked authority produces no dispatch and discloses nothing', async () => {
    const f = await fixture()
    await revokeGroupGrant(connection.db, f.workspace.id, f.channelId, f.owner, {
      grantId: 'gra_lead',
      kind: 'enlistment',
      revokedAt: new Date().toISOString(),
    })
    const agentRevoked = await address(f, request(f, f.lead.id))
    expect(agentRevoked.status).toBe(404)
    expect(await agentRevoked.text()).not.toContain('revoked')
    await revokeGroupGrant(connection.db, f.workspace.id, f.channelId, f.owner, {
      grantId: 'gra_owner',
      kind: 'audience',
      revokedAt: new Date().toISOString(),
    })
    expect((await address(f, request(f, f.helper.id))).status).toBe(404)
    expect((await list(f)).status).toBe(404)
    expect(await claims(f)).toHaveLength(0)
    expect(await intents(f)).toBe(0)
  })

  test('a retry after the addresser lost authority returns the retained turn to no one', async () => {
    const f = await fixture()
    expect((await address(f, request(f, f.lead.id))).status).toBe(201)
    await revokeGroupGrant(connection.db, f.workspace.id, f.channelId, f.owner, {
      grantId: 'gra_owner',
      kind: 'audience',
      revokedAt: new Date().toISOString(),
    })
    const retry = await address(f, request(f, f.lead.id))
    expect(retry.status).toBe(404)
    expect(await retry.text()).not.toContain('turn:')
    expect(await claims(f)).toHaveLength(1)
    expect(await intents(f)).toBe(1)
  })

  test('newer human input supersedes the turn, and the stale retry is a conflict with no dispatch', async () => {
    const f = await fixture()
    const live = (await (await address(f, request(f, f.lead.id))).json()) as {
      turn: { id: string }
    }
    await f.post(f.member, 'a different question')
    const replay = (await (await list(f)).json()) as { turns: { id: string; state: string }[] }
    expect(replay.turns).toEqual([
      expect.objectContaining({ id: live.turn.id, state: 'superseded' }),
    ])
    const before = await intents(f)
    const stale = await address(f, request(f, f.lead.id))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'turn_conflict', reason: 'turn_superseded' })
    expect(await intents(f)).toBe(before)
  })

  test('Agent messages never address: an Agent-authored trigger is refused and nothing is claimed', async () => {
    const f = await fixture()
    const chatter = await postGroupChannelMessage(
      connection.db,
      f.workspace.id,
      f.channelId,
      f.owner,
      { agentId: f.helper.id, kind: 'agent' },
      { message: { bodyText: 'helper muses', idempotencyKey: randomUUID() }, mode: 'direct' },
      { now: NOW }
    )
    expect(await claims(f)).toHaveLength(0)
    const response = await address(f, {
      agentId: f.lead.id,
      dispatchRevision: 1,
      triggerMessageId: chatter.id,
    })
    expect(response.status).toBe(404)
    expect(await claims(f)).toHaveLength(0)
  })

  test('the tree budget is enforced as a conflict and retained turns still converge when full', async () => {
    const f = await fixture()
    for (let revision = 1; revision <= 8; revision += 1)
      expect((await address(f, request(f, f.helper.id, revision))).status).toBe(201)
    const over = await address(f, request(f, f.helper.id, 9))
    expect(over.status).toBe(409)
    expect(await over.json()).toMatchObject({ reason: 'turn_budget_exhausted' })
    expect((await address(f, request(f, f.helper.id, 1))).status).toBe(200)
    expect(await claims(f)).toHaveLength(8)
  })

  test('replay pages in committed order and rejects malformed cursors and parameters', async () => {
    const f = await fixture()
    const ids: string[] = []
    for (const revision of [1, 2, 3]) {
      const body = (await (await address(f, request(f, f.helper.id, revision))).json()) as {
        turn: { id: string }
      }
      ids.push(body.turn.id)
    }
    const page1 = (await (await list(f, '?limit=2')).json()) as {
      nextAfter: string | null
      turns: { id: string }[]
    }
    expect(page1.turns.map((turn) => turn.id)).toEqual(ids.slice(0, 2))
    expect(page1.nextAfter).toBe(ids[1]!)
    const page2 = (await (await list(f, `?after=${page1.nextAfter}&limit=2`)).json()) as {
      nextAfter: string | null
      turns: { id: string }[]
    }
    expect(page2.turns.map((turn) => turn.id)).toEqual([ids[2]!])
    expect(page2.nextAfter).toBeNull()
    for (const query of [
      '?after=nope',
      `?after=${randomUUID()}`,
      '?limit=0',
      '?limit=201',
      '?limit=abc',
      '?extra=1',
    ])
      expect((await list(f, query)).status).toBe(400)
  })

  test('bounded replay scan exhaustion is a retryable 503 with no hidden turn IDs', async () => {
    const f = await fixture()
    const hidden = await address(f, request(f, f.helper.id))
    const hiddenTurn = (await hidden.json()) as { turn: { id: string } }
    const extraHidden = Array.from({ length: 1_000 }, (_, index) => {
      const revision = index + 2
      return {
        addresserUserId: f.owner.userId,
        addressedLabel: `${f.workspace.id}:${f.helper.id}`,
        agentId: f.helper.id,
        causalId: `turn:${f.trigger.id}:${f.helper.id}:${revision}`,
        channelId: f.channelId,
        depth: 0,
        dispatchRevision: revision,
        id: randomUUID(),
        maxDepth: 2,
        maxTurns: 8,
        parentTurnId: null,
        responseMessageId: null,
        state: 'claimed',
        triggerMessageId: f.trigger.id,
        workspaceId: f.workspace.id,
      }
    })
    await connection.db.insert(addressedAgentTurns).values(extraHidden)

    // The bystander joins after the trigger, so all retained turns above are hidden by the canonical
    // message join point. A bounded reader must refuse the incomplete page instead of returning an
    // empty page that would let the caller conclude history is exhausted.
    const [channel] = await connection.db
      .select({ version: channels.version })
      .from(channels)
      .where(eq(channels.id, f.channelId))
      .limit(1)
    if (!channel) throw new Error('Test channel missing')
    await setGroupChannelParticipantsWithGrants(
      connection.db,
      f.workspace.id,
      f.channelId,
      f.owner,
      {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [
            audienceGrant(f.channelId, f.owner, 'gra_owner'),
            audienceGrant(f.channelId, f.member, 'gra_member'),
            audienceGrant(f.channelId, f.bystander, 'gra_bystander'),
          ],
          enlistmentGrants: [
            enlistmentGrant(f.channelId, f.lead.id, f.workspace.id, 'gra_lead'),
            enlistmentGrant(f.channelId, f.helper.id, f.workspace.id, 'gra_helper'),
          ],
        }),
        expectedVersion: channel.version,
        now: new Date().toISOString(),
      }
    )

    const response = await list(f, '?limit=1', f.bystander)
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const body = await response.text()
    expect(JSON.parse(body)).toMatchObject({ code: 'turns_read_failed' })
    expect(body).not.toContain(hiddenTurn.turn.id)
    for (const turn of extraHidden.slice(0, 8)) expect(body).not.toContain(turn.id)
    expect(body).not.toContain('nextAfter')
  })

  test('cancellation is limited to the addresser or a manager, takes no input, and ends dispatch', async () => {
    const f = await fixture()
    const made = (await (await address(f, request(f, f.helper.id))).json()) as {
      turn: { id: string }
    }
    expect((await cancel(f, made.turn.id, null)).status).toBe(401)
    expect((await cancel(f, made.turn.id, f.member)).status).toBe(404)
    expect((await cancel(f, made.turn.id, f.stranger)).status).toBe(404)
    expect((await cancel(f, made.turn.id, f.owner, { force: true })).status).toBe(400)
    expect((await cancel(f, randomUUID(), f.owner)).status).toBe(404)
    expect((await cancel(f, 'not-a-uuid', f.owner)).status).toBe(404)
    const done = await cancel(f, made.turn.id, f.owner)
    expect(done.status).toBe(200)
    expect(await done.json()).toMatchObject({
      runtimeCancelRequested: false,
      turn: { id: made.turn.id, state: 'cancelled' },
    })
    expect((await cancel(f, made.turn.id, f.owner)).status).toBe(200)
    const lead = (await (await address(f, request(f, f.lead.id, 4))).json()) as {
      turn: { id: string }
    }
    expect((await cancel(f, lead.turn.id, f.owner)).status).toBe(200)
    const redispatch = await address(f, request(f, f.lead.id, 4))
    expect(redispatch.status).toBe(409)
    expect(await redispatch.json()).toMatchObject({ reason: 'turn_cancelled' })
  })

  test('an oversized, mis-sized or failing cancel body is refused before any cancellation', async () => {
    const f = await fixture()
    const made = (await (await address(f, request(f, f.helper.id))).json()) as {
      turn: { id: string }
    }
    const raw = (init: RequestInit & { duplex?: 'half' }) =>
      cancelRoute.server.handlers.POST({
        params: { channelId: f.channelId, turnId: made.turn.id, workspaceId: f.workspace.id },
        request: new Request(
          `http://localhost/api/v1/workspaces/${f.workspace.id}/channels/${f.channelId}/turns/${made.turn.id}/cancel`,
          {
            ...init,
            headers: { 'x-test-user-id': f.owner.userId, ...(init.headers as object) },
            method: 'POST',
          }
        ),
      })
    const state = async () => (await claims(f)).find((turn) => turn.id === made.turn.id)?.state
    // Oversized: the stream crosses the limit, so the read yields nothing usable.
    expect((await raw({ body: ' '.repeat(4096) })).status).toBe(400)
    // A claimed length above the limit is refused unread.
    expect((await raw({ body: '{}', headers: { 'content-length': '999999' } })).status).toBe(400)
    // A malformed length claim.
    expect((await raw({ body: '{}', headers: { 'content-length': 'abc' } })).status).toBe(400)
    // A body stream that fails mid-read.
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('client went away'))
      },
    })
    expect((await raw({ body: failing, duplex: 'half' })).status).toBe(400)
    expect(await state()).toBe('claimed')
    // A genuinely absent body still cancels: no input is the normal cancel request.
    expect((await raw({})).status).toBe(200)
    expect(await state()).toBe('cancelled')
  })
})
