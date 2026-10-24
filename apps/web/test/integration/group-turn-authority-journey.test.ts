// The group-authority journey for an addressed Agent turn (M15 #1178/#1179/#1180).
//
// Coverage class: real route modules, real handlers, real database, real durable coordinator and the
// real publication store. The same two seams as addressed-turn-routes.test.ts are injected:
//   - `@tanstack/solid-router` is replaced with an identity `createFileRoute`, so the route modules
//     load under bun. The handlers are the production functions, reached through
//     `Route.server.handlers`.
//   - `resolveWorkspacePrincipal` reads the caller from an `x-test-user-id` header instead of a
//     session cookie.
//
// The journey this file proves:
//   1. A human addresses an Agent through the real HTTP route.
//   2. The durable claim RETAINS the exact participation grant (id and revision) that admitted the
//      work.
//   3. The roster changes under that work: the Agent is removed and added again under a new, higher
//      grant revision, or its grant is revoked, or it expires.
//   4. The late result is HELD by the group publication gate with its typed reason, writes nothing
//      into the group, and leaves the independently owned job untouched.
//
// Runs under `bun run test:integration` (react-server condition required):
//   DATABASE_URL=... DATABASE_URL_UNPOOLED=... DATABASE_MIGRATION_URL=... \
//     bun test --conditions=react-server --timeout 60000 \
//     apps/web/test/integration/group-turn-authority-journey.test.ts

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { UserPrincipalRef } from '@adea-ai/types'

import {
  addWorkspaceMembership,
  addressedAgentTurns,
  agents,
  channels,
  createAgent,
  createDatabase,
  createGroupChannelWithGrants,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  groupCreationCandidatesFromGrants,
  groupEnlistmentGrants,
  leadTurnRuntime,
  markLeadTurnDispatchPending,
  messages,
  observeLeadTurnRuntime,
  postGroupChannelMessage,
  prepareLeadTurnRuntime,
  publishLeadTurnResult,
  setGroupChannelParticipantsWithGrants,
  workspaces,
  type DatabaseConnection,
} from '@adea-ai/db'

const connectionUrl = process.env.DATABASE_URL

if (!connectionUrl) {
  // A missing database fails the lane; a silent skip would hide every route flow.
  throw new Error(
    'DATABASE_URL is required for the group-turn authority journey lane: run it through `bun run test:integration`'
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

function enlistmentGrant(
  groupId: string,
  agentId: string,
  workspaceId: string,
  grantId: string,
  revision = 1
) {
  return {
    agent: { agentId, workspaceId },
    expiresAt: null,
    grantId,
    groupId,
    issuedAt: ISSUED,
    revision,
    revokedAt: null,
  }
}

describe.skipIf(!connectionUrl)('group turn authority journey: route to held publication', () => {
  let connection: DatabaseConnection
  let turnsRoute: RouteModule

  beforeAll(async () => {
    connection = createDatabase(connectionUrl!)
    turnsRoute = (
      await import('../../src/start/routes/api/v1/workspaces/$workspaceId/channels/$channelId/turns')
    ).Route as unknown as RouteModule
  })

  afterAll(async () => connection?.close())

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `turn-journey-${label}-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 120_000),
      })
    ).principal
  }

  async function fixture() {
    const owner = await user('owner')
    const member = await user('member')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: randomUUID(),
      name: 'Turn journey',
      owner,
    })
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
    const lead = await createAgent(connection.db, workspace.id, owner, {
      name: 'Lead',
      profileId: 'lead',
      profileVersion: '1',
    })
    await connection.db.update(agents).set({ isWorkspaceLead: true }).where(eq(agents.id, lead.id))
    const channelId = randomUUID()
    await createGroupChannelWithGrants(connection.db, workspace.id, owner, {
      candidates: groupCreationCandidatesFromGrants(workspace.id, {
        audienceGrants: [
          audienceGrant(channelId, owner, 'gra_owner'),
          audienceGrant(channelId, member, 'gra_member'),
        ],
        enlistmentGrants: [enlistmentGrant(channelId, lead.id, workspace.id, 'gra_lead')],
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
    return { channelId, lead, member, owner, post, trigger, workspace }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function call(
    method: 'GET' | 'POST',
    f: Fixture,
    options: { as?: UserPrincipalRef | null; body?: unknown } = {}
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
      `http://localhost/api/v1/workspaces/${f.workspace.id}/channels/${f.channelId}/turns`,
      { headers, method, ...(raw === undefined ? {} : { body: raw }) }
    )
    return turnsRoute.server.handlers[method]({
      params: { channelId: f.channelId, workspaceId: f.workspace.id },
      request,
    })
  }
  const address = (f: Fixture, body: unknown, as: UserPrincipalRef | null = f.owner) =>
    call('POST', f, { as, body })
  const list = (f: Fixture, as: UserPrincipalRef | null = f.owner) => call('GET', f, { as })
  const addressBody = (f: Fixture, agentId: string, dispatchRevision = 1) => ({
    agentId,
    dispatchRevision,
    triggerMessageId: f.trigger.id,
  })

  /** The durable claim row, with the participation binding it retained. */
  const claim = async (f: Fixture) => {
    const [row] = await connection.db
      .select()
      .from(addressedAgentTurns)
      .where(eq(addressedAgentTurns.channelId, f.channelId))
    if (!row) throw new Error('Journey claim missing')
    return row
  }

  /** The channel's own message frontier: the trigger plus whatever was published. */
  const channelMessages = async (f: Fixture) =>
    connection.db
      .select({ id: messages.id, senderKind: messages.senderKind })
      .from(messages)
      .where(eq(messages.channelId, f.channelId))

  /** Drives the dispatched intent through the real runtime path to a publishable result. */
  async function complete(f: Fixture, intentId: string) {
    const [workspace] = await connection.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, f.workspace.id))
    const execution = randomUUID()
      .replaceAll('-', '')
      .slice(0, 26)
      .toUpperCase()
      .replace(/[ILOU]/g, '0')
    const pin = {
      attemptId: `att_${execution}`,
      executionId: `exe_${execution}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      intentId,
      preparationRef: `prep_${randomUUID().replaceAll('-', '')}`,
      selectionRef: `msel_${randomUUID().replaceAll('-', '')}`,
      selectionRevision: 1,
      workspaceId: workspace!.controlPlaneWorkspaceId,
    }
    const binding = {
      attemptId: pin.attemptId,
      dispatchId: `dispatch_${randomUUID().replaceAll('-', '')}`,
      executionId: pin.executionId,
      intentId,
      runtimeSessionId: `ses_${execution}`,
    }
    await prepareLeadTurnRuntime(connection.db, f.workspace.id, intentId, f.owner, pin)
    await markLeadTurnDispatchPending(connection.db, f.workspace.id, intentId, f.owner, pin)
    await observeLeadTurnRuntime(connection.db, f.workspace.id, intentId, f.owner, {
      ...binding,
      observedAt: new Date().toISOString(),
      state: 'completed',
    })
    return () =>
      publishLeadTurnResult(
        connection.db,
        f.workspace.id,
        intentId,
        f.owner,
        binding,
        'The answer',
        async () => {}
      )
  }

  /** Removes the addressed Agent and adds it again under a new, higher grant revision. */
  async function removeThenReaddLead(f: Fixture) {
    const version = async () => {
      const [channel] = await connection.db
        .select({ version: channels.version })
        .from(channels)
        .where(eq(channels.id, f.channelId))
        .limit(1)
      if (!channel) throw new Error('Journey channel missing')
      return channel.version
    }
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
          ],
          enlistmentGrants: [],
        }),
        expectedVersion: await version(),
        now: new Date().toISOString(),
      }
    )
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
          ],
          enlistmentGrants: [
            enlistmentGrant(f.channelId, f.lead.id, f.workspace.id, 'gra_lead', 2),
          ],
        }),
        expectedVersion: await version(),
        now: new Date().toISOString(),
      }
    )
  }

  test('the addressed turn retains the exact participation grant that admitted the work', async () => {
    const f = await fixture()
    const response = await address(f, addressBody(f, f.lead.id))
    expect(response.status).toBe(201)
    const row = await claim(f)
    expect(row).toMatchObject({ authGrantId: 'gra_lead', authRevision: 1 })
    expect(row.intentId).toBeString()
  })

  test('a removed and re-added Agent does not authorize the old work: the late result is held', async () => {
    const f = await fixture()
    const response = await address(f, addressBody(f, f.lead.id))
    expect(response.status).toBe(201)
    const row = await claim(f)
    const intentId = row.intentId!
    const publish = await complete(f, intentId)
    await removeThenReaddLead(f)
    // The Agent's new grant revision is live for the Agent; the work admitted
    // under the old one is held with the typed group reason.
    await expect(publish()).rejects.toMatchObject({
      name: 'GroupPublicationHoldError',
      reason: 'publication_binding_mismatch',
    })
    // Nothing entered the group, and the independently owned job survives.
    expect(await channelMessages(f)).toHaveLength(1)
    const [runtime] = await connection.db
      .select()
      .from(leadTurnRuntime)
      .where(eq(leadTurnRuntime.intentId, intentId))
    expect(runtime).toMatchObject({ publishedMessageId: null, state: 'completed' })
    const [held] = await connection.db
      .select()
      .from(addressedAgentTurns)
      .where(eq(addressedAgentTurns.id, row.id))
    expect(held).toMatchObject({ responseMessageId: null })
    // The route surface still serves the retained turn to its addresser.
    const replay = (await (await list(f)).json()) as { turns: { id: string; state: string }[] }
    expect(replay.turns.map((turn) => turn.id)).toEqual([row.id])
  })

  test('a revoked enlistment holds the late result with the typed revocation reason', async () => {
    const f = await fixture()
    const response = await address(f, addressBody(f, f.lead.id))
    expect(response.status).toBe(201)
    const row = await claim(f)
    const publish = await complete(f, row.intentId!)
    await connection.db
      .update(groupEnlistmentGrants)
      .set({ revokedAt: new Date().toISOString() })
      .where(
        and(
          eq(groupEnlistmentGrants.channelId, f.channelId),
          eq(groupEnlistmentGrants.grantId, 'gra_lead')
        )
      )
    await expect(publish()).rejects.toMatchObject({
      name: 'GroupPublicationHoldError',
      reason: 'publication_participation_revoked',
    })
    expect(await channelMessages(f)).toHaveLength(1)
  })

  test('an expired enlistment holds the late result with the typed stale reason', async () => {
    const f = await fixture()
    const response = await address(f, addressBody(f, f.lead.id))
    expect(response.status).toBe(201)
    const row = await claim(f)
    const publish = await complete(f, row.intentId!)
    await connection.db
      .update(groupEnlistmentGrants)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(
        and(
          eq(groupEnlistmentGrants.channelId, f.channelId),
          eq(groupEnlistmentGrants.grantId, 'gra_lead')
        )
      )
    await expect(publish()).rejects.toMatchObject({
      name: 'GroupPublicationHoldError',
      reason: 'publication_participation_stale',
    })
    expect(await channelMessages(f)).toHaveLength(1)
  })
})
