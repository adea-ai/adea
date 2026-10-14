// Client convergence for addressed group turns (#1179): the real client, the real route handlers, the real
// database and coordinator, and the same ledger and address queue the group UI runs.
//
// Each "session" is one browser tab: its own client, its own held copy of the turns. The proof is that every
// way a tab can learn about a turn (an address response, a cancel response, a replay after a reconnect, a
// retry after a lost response, a second tab doing the same) ends on the one turn the database holds.
//
// Runs under `bun run test:integration`:
//   DATABASE_URL=... DATABASE_URL_UNPOOLED=... DATABASE_MIGRATION_URL=... \
//     bun test --conditions=react-server --timeout 60000 \
//     apps/web/test/integration/addressed-turn-client-convergence.test.ts

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

import { AgentHqApiClient, type ApiAddressedTurn } from '@adea-ai/api-client'
import {
  addressedAgentTurns,
  addWorkspaceMembership,
  agents,
  createAgent,
  createDatabase,
  createGroupChannelWithGrants,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  groupCreationCandidatesFromGrants,
  leadTurnIntents,
  postGroupChannelMessage,
  revokeGroupGrant,
  type DatabaseConnection,
  type UserPrincipalRef,
} from '@adea-ai/db'
import { QueryClient } from '@tanstack/solid-query'
import {
  addressedTurnQueryKeys,
  addressedTurnQueryOptions,
  foldAddressedTurnCache,
  foldTurnIntoReplay,
  replayAddressedTurns,
  type AddressedTurnReplay,
} from '../../../../packages/data/src/addressed-turns'
import {
  addressedTurnFailure,
  createAddressingQueue,
  type AddressingIntent,
} from '../../../../packages/workspace-ui/src/addressed-turn-model'

const connectionUrl = process.env.DATABASE_URL

if (!connectionUrl) {
  throw new Error(
    'DATABASE_URL is required for the addressed-turn convergence lane: run it through `bun run test:integration`'
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

const summary = (turns: readonly ApiAddressedTurn[]) =>
  turns.map(({ causalId, id, state }) => ({ causalId, id, state }))

describe.skipIf(!connectionUrl)('addressed turns: client convergence', () => {
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
        credentialDigest: `turn-converge-${label}-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 120_000),
      })
    ).principal
  }

  async function fixture() {
    const owner = await user('owner')
    const member = await user('member')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: randomUUID(),
      name: 'Convergence',
      owner,
    })
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
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
    const grant = (participant: UserPrincipalRef, grantId: string) => ({
      expiresAt: null,
      grantId,
      groupId: channelId,
      issuedAt: ISSUED,
      participant,
      revision: 1,
      revokedAt: null,
    })
    const enlist = (agentId: string, grantId: string) => ({
      agent: { agentId, workspaceId: workspace.id },
      expiresAt: null,
      grantId,
      groupId: channelId,
      issuedAt: ISSUED,
      revision: 1,
      revokedAt: null,
    })
    await createGroupChannelWithGrants(connection.db, workspace.id, owner, {
      candidates: groupCreationCandidatesFromGrants(workspace.id, {
        audienceGrants: [grant(owner, 'gra_owner'), grant(member, 'gra_member')],
        enlistmentGrants: [enlist(lead.id, 'gra_lead'), enlist(helper.id, 'gra_helper')],
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
    return { channelId, helper, lead, member, owner, post, workspace }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  /** One browser tab: its own client against the real handlers, its own held turns, its own queue. */
  function openTab(f: Fixture, as: UserPrincipalRef) {
    const state = { dropResponses: 0, held: undefined as AddressedTurnReplay | undefined }
    const client = new AgentHqApiClient({
      baseUrl: '/api',
      fetchImpl: async (input, init) => {
        const request = new Request(`http://localhost${input}`, init)
        request.headers.set('x-test-user-id', as.userId)
        const path = new URL(request.url).pathname
        const cancel = path.match(/\/turns\/([^/]+)\/cancel$/)
        const route = cancel ? cancelRoute : turnsRoute
        const response = await route.server.handlers[request.method as 'GET' | 'POST']({
          params: {
            channelId: f.channelId,
            workspaceId: f.workspace.id,
            ...(cancel ? { turnId: cancel[1]! } : {}),
          },
          request,
        })
        // A dropped response reached the server and was handled; the tab never hears about it.
        if (state.dropResponses > 0) {
          state.dropResponses -= 1
          throw new TypeError('Failed to fetch')
        }
        return response
      },
    })
    const learn = (turn: ApiAddressedTurn) => {
      state.held = foldTurnIntoReplay(state.held, turn, 0)
    }
    const intents: AddressingIntent[][] = []
    const queue = createAddressingQueue({
      onChange: (next) => intents.push([...next]),
      send: async (input) => {
        const response = await client.addressTurn(f.workspace.id, f.channelId, input)
        learn(response.turn)
        return response
      },
    })
    return {
      client,
      intents,
      queue,
      state,
      turns: () => state.held?.turns ?? [],
      address: async (agentId: string, triggerMessageId: string, revision = 1) => {
        const response = await client.addressTurn(f.workspace.id, f.channelId, {
          agentId,
          dispatchRevision: revision,
          triggerMessageId,
        })
        learn(response.turn)
        return response
      },
      cancel: async (turnId: string) => {
        const response = await client.cancelAddressedTurn(f.workspace.id, f.channelId, turnId)
        learn(response.turn)
        return response
      },
      replay: async () => {
        const read = await replayAddressedTurns(client, f.workspace.id, f.channelId, {
          heldAtStart: state.held?.turns.map(({ causalId }) => causalId) ?? [],
        })
        state.held = foldAddressedTurnCache(state.held, {
          ...read,
          conversationAudienceEpoch: 0,
        }) as AddressedTurnReplay
        return read
      },
    }
  }

  const rows = (f: Fixture) =>
    connection.db
      .select()
      .from(addressedAgentTurns)
      .where(eq(addressedAgentTurns.workspaceId, f.workspace.id))
  const intentCount = async (f: Fixture) =>
    (
      await connection.db
        .select({ id: leadTurnIntents.id })
        .from(leadTurnIntents)
        .where(eq(leadTurnIntents.workspaceId, f.workspace.id))
    ).length

  test('two tabs addressing the same Agent at once converge on one durable turn', async () => {
    const f = await fixture()
    const trigger = await f.post(f.owner, 'please answer')
    const first = openTab(f, f.owner)
    const second = openTab(f, f.owner)
    const [a, b] = await Promise.all([
      first.address(f.lead.id, trigger.id),
      second.address(f.lead.id, trigger.id),
    ])
    expect([a.created, b.created].toSorted()).toEqual([false, true])
    expect(a.turn.id).toBe(b.turn.id)
    expect(await rows(f)).toHaveLength(1)
    expect(await intentCount(f)).toBe(1)
    await first.replay()
    await second.replay()
    expect(summary(first.turns())).toEqual(summary(second.turns()))
    expect(first.turns()).toHaveLength(1)
  })

  test('a response lost on the wire is retried on reconnect and still starts one turn', async () => {
    const f = await fixture()
    const trigger = await f.post(f.owner, 'please answer')
    const tab = openTab(f, f.owner)
    tab.state.dropResponses = 1
    await tab.queue.enqueue([
      { agentId: f.lead.id, dispatchRevision: 1, triggerMessageId: trigger.id },
    ])
    // The server committed the turn; the tab did not hear, so it holds a failed, transient intent.
    expect(await rows(f)).toHaveLength(1)
    expect(tab.turns()).toHaveLength(0)
    expect(tab.queue.intents()).toHaveLength(1)
    expect(tab.queue.intents()[0]).toMatchObject({ status: 'failed', failure: { retryable: true } })
    // The connection returns: the identical request is sent again and the server hands back its turn.
    await tab.queue.retryTransient()
    expect(tab.queue.intents()).toEqual([])
    expect(await rows(f)).toHaveLength(1)
    expect(await intentCount(f)).toBe(1)
    expect(tab.turns()).toHaveLength(1)
    await tab.replay()
    expect(tab.turns()).toHaveLength(1)
  })

  test('a tab that reconnects reads the same turns, in the same order, as the tab that made them', async () => {
    const f = await fixture()
    const first = await f.post(f.owner, 'first question')
    const second = await f.post(f.owner, 'second question')
    const author = openTab(f, f.owner)
    // The first message's turns are created before the second message: the second supersedes them.
    await author.address(f.lead.id, first.id)
    await author.address(f.helper.id, first.id)
    await author.address(f.lead.id, second.id)
    await author.replay()
    const reader = openTab(f, f.member)
    await reader.replay()
    expect(summary(reader.turns())).toEqual(summary(author.turns()))
    expect(reader.turns().map((turn) => turn.triggerMessageId)).toEqual([
      first.id,
      first.id,
      second.id,
    ])
    // The server's own page order is the order held, however it was paged.
    const paged = await replayAddressedTurns(reader.client, f.workspace.id, f.channelId, {
      pageSize: 1,
    })
    expect(paged.complete).toBe(true)
    expect(summary(paged.turns)).toEqual(summary(reader.turns()))
    // Only the addresser holds the lead-turn intent.
    expect(reader.turns().every((turn) => turn.leadTurnIntentId === null)).toBe(true)
    expect(author.turns().some((turn) => turn.leadTurnIntentId !== null)).toBe(true)
  })

  test('a stale replay arriving after a cancel cannot bring the turn back to life', async () => {
    const f = await fixture()
    const trigger = await f.post(f.owner, 'please answer')
    const tab = openTab(f, f.owner)
    const { turn } = await tab.address(f.helper.id, trigger.id)
    // The tab starts a read, the cancel lands, and the read's page was cut before the cancel committed.
    const staleRead = await replayAddressedTurns(tab.client, f.workspace.id, f.channelId, {
      heldAtStart: tab.state.held?.turns.map(({ causalId }) => causalId) ?? [],
    })
    expect(staleRead.turns[0]?.state).toBe('claimed')
    const cancelled = await tab.cancel(turn.id)
    expect(cancelled.turn.state).toBe('cancelled')
    tab.state.held = foldAddressedTurnCache(tab.state.held, {
      ...staleRead,
      conversationAudienceEpoch: 0,
    })
    expect(tab.turns().map((entry) => entry.state)).toEqual(['cancelled'])
    // A second tab that never saw the turn live learns the cancelled state from the server.
    const other = openTab(f, f.owner)
    await other.replay()
    expect(other.turns().map((entry) => entry.state)).toEqual(['cancelled'])
    // A repeated cancel (a double click, a second tab) answers with the same cancelled turn.
    const repeat = await tab.cancel(turn.id)
    expect(repeat.turn).toMatchObject({ id: turn.id, state: 'cancelled' })
    expect(repeat.turn.updatedAt).toBe(cancelled.turn.updatedAt)
    expect(tab.turns().map((entry) => entry.state)).toEqual(['cancelled'])
    expect((await rows(f))[0]?.state).toBe('cancelled')
  })

  test('newer human input supersedes the turn, and every tab shows it superseded without a rerun', async () => {
    const f = await fixture()
    const trigger = await f.post(f.owner, 'first')
    const tab = openTab(f, f.owner)
    const { turn } = await tab.address(f.lead.id, trigger.id)
    expect(turn.state).toBe('dispatching')
    await f.post(f.owner, 'second, newer')
    const intentsBefore = await intentCount(f)
    await tab.replay()
    expect(tab.turns().map((entry) => entry.state)).toEqual(['superseded'])
    // The stale retry is refused and carries its reason; no turn, claim or intent is added.
    const retry = await tab.queue
      .enqueue([{ agentId: f.lead.id, dispatchRevision: 1, triggerMessageId: trigger.id }])
      .then(() => tab.queue.intents()[0])
    expect(retry).toMatchObject({ status: 'failed', failure: { retryable: false } })
    expect(retry?.failure?.text).toContain('newer message')
    expect(await rows(f)).toHaveLength(1)
    expect(await intentCount(f)).toBe(intentsBefore)
    expect(tab.turns().map((entry) => entry.state)).toEqual(['superseded'])
  })

  test('a populated reader who is then revoked loses the held turns on the 404, not on a 503', async () => {
    const f = await fixture()
    const trigger = await f.post(f.owner, 'please answer')
    await openTab(f, f.owner).address(f.lead.id, trigger.id)
    const reader = openTab(f, f.member)
    const queryClient = new QueryClient()
    const options = addressedTurnQueryOptions.list(reader.client, f.workspace.id, f.channelId)
    const key = addressedTurnQueryKeys.list(f.workspace.id, f.channelId)
    await queryClient.fetchQuery({ ...options, staleTime: 0 })
    expect(queryClient.getQueryData<AddressedTurnReplay>(key)!.turns).toHaveLength(1)
    await revokeGroupGrant(connection.db, f.workspace.id, f.channelId, f.owner, {
      grantId: 'gra_member',
      kind: 'audience',
      revokedAt: new Date().toISOString(),
    })
    // No revocation event reached this tab: the refresh itself learns it from the real 404.
    await queryClient.fetchQuery({ ...options, staleTime: 0, retry: false })
    const after = queryClient.getQueryData<AddressedTurnReplay>(key)!
    expect(after.turns).toEqual([])
    expect(after.unavailable).toBe(true)
  })

  test('a reader who lost the audience gets an error, not an empty or stale list, and learns nothing', async () => {
    const f = await fixture()
    const trigger = await f.post(f.owner, 'please answer')
    const author = openTab(f, f.owner)
    await author.address(f.lead.id, trigger.id)
    await revokeGroupGrant(connection.db, f.workspace.id, f.channelId, f.owner, {
      grantId: 'gra_member',
      kind: 'audience',
      revokedAt: new Date().toISOString(),
    })
    const revoked = openTab(f, f.member)
    const failure = await revoked.replay().then(
      () => null,
      (error: unknown) => error
    )
    expect(failure).toMatchObject({ status: 404 })
    expect(revoked.turns()).toEqual([])
    const copy = addressedTurnFailure(failure, 'address').text
    for (const canary of [f.lead.id, trigger.id, f.workspace.id, 'revoked', 'enlist']) {
      expect(`${(failure as Error).message} ${copy}`).not.toContain(canary)
    }
    // A tab that held the turns before the revocation keeps no new truth: the next replay also fails.
    const held = openTab(f, f.owner)
    await held.replay()
    expect(held.turns()).toHaveLength(1)
  })
})
