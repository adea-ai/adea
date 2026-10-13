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
import { and, eq } from 'drizzle-orm'

import {
  addWorkspaceMembership,
  channels,
  createAgent,
  createDatabase,
  createMessage,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  findWorkspaceMembership,
  messages,
  removeWorkspaceMembership,
  revokeGroupGrant,
  workspaceMemberships,
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
type OperationOutcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

function observeOperation<T>(operation: Promise<T>): Promise<OperationOutcome<T>> {
  return operation.then(
    (value): OperationOutcome<T> => ({ status: 'fulfilled', value }),
    (reason: unknown): OperationOutcome<T> => ({ status: 'rejected', reason })
  )
}

async function waitForGate(gate: Promise<void>, message: string, timeoutMs = 5_000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      gate,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function settleOwnedOperations(
  operations: readonly Promise<OperationOutcome<unknown>>[],
  primaryFailure: { reason: unknown } | null
) {
  const outcomes = await Promise.all(operations)
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : []
  )
  if (primaryFailure) failures.unshift(primaryFailure.reason)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'A race test failed while settling its background operations'
    )
  }
}

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

async function expectUnavailableWithoutAgentDisclosure(
  response: Response,
  agentId: string,
  sourceWorkspaceId: string
) {
  expect(response.status).toBe(404)
  const body = await response.text()
  expect(body).not.toContain(agentId)
  expect(body).not.toContain(sourceWorkspaceId)
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
    const outsider = await user('outsider')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: randomUUID(),
      name: 'Group routes',
      owner,
    })
    await addWorkspaceMembership(connection.db, workspace.id, member, 'admin')
    const plain = await user('plain')
    await addWorkspaceMembership(connection.db, workspace.id, plain, 'member')
    return { member, outsider, owner, plain, workspace }
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

  async function postAgentGroup(
    host: Awaited<ReturnType<typeof fixture>>,
    agent: Readonly<{ id: string; workspaceId: string }>,
    claimedWorkspaceId = agent.workspaceId
  ) {
    const channelId = randomUUID()
    const response = await call(
      channelsRoute,
      'POST',
      `/api/v1/workspaces/${host.workspace.id}/channels`,
      { workspaceId: host.workspace.id },
      {
        as: host.owner,
        idempotencyKey: randomUUID(),
        body: {
          kind: 'group',
          title: 'Foreign Agent group',
          channelId,
          audienceGrants: [],
          enlistmentGrants: [
            {
              agent: { agentId: agent.id, workspaceId: claimedWorkspaceId },
              expiresAt: null,
              grantId: `gra_agent_${channelId}`,
              groupId: channelId,
              issuedAt: ISSUED,
              revision: 1,
              revokedAt: null,
            },
          ],
        },
      }
    )
    return { channelId, response }
  }

  async function waitForSourceMembershipLock() {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const waiters = await connection.client.unsafe<{ pid: number }[]>(
        `select pid from pg_stat_activity where datname = current_database() and usename = current_user and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%workspace_memberships%'`
      )
      if (waiters.length > 0) return true
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return false
  }

  test('an unrelated host owner cannot enlist a foreign Agent or learn its source identity', async () => {
    const host = await fixture()
    const sourceOwner = await user('foreign-agent-source-owner')
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: randomUUID(),
      name: 'Foreign Agent source',
      owner: sourceOwner,
    })
    const foreignAgent = await createAgent(connection.db, source.id, sourceOwner, {
      name: 'Foreign Agent',
      profileId: `prf_${'0'.repeat(25)}1`,
      profileVersion: `pfv_${'0'.repeat(25)}1`,
    })
    expect(await findWorkspaceMembership(connection.db, source.id, host.owner)).toBeNull()
    const { channelId, response } = await postAgentGroup(host, foreignAgent)
    await expectUnavailableWithoutAgentDisclosure(response, foreignAgent.id, source.id)
    const rows = await connection.db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId))
    expect(rows).toHaveLength(0)
  })

  test('a forged source-workspace claim cannot substitute host authority for canonical source authority', async () => {
    const host = await fixture()
    const sourceOwner = await user('forged-agent-source-owner')
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: randomUUID(),
      name: 'Canonical Agent source',
      owner: sourceOwner,
    })
    const foreignAgent = await createAgent(connection.db, source.id, sourceOwner, {
      name: 'Canonical Agent',
      profileId: `prf_${'0'.repeat(25)}2`,
      profileVersion: `pfv_${'0'.repeat(25)}2`,
    })

    // The host owner controls the claimed workspace but not the Agent's real home.
    const { response } = await postAgentGroup(host, foreignAgent, host.workspace.id)
    await expectUnavailableWithoutAgentDisclosure(response, foreignAgent.id, source.id)
  })

  test('a source membership revoked before enlistment is denied', async () => {
    const host = await fixture()
    const sourceOwner = await user('revoked-agent-source-owner')
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: randomUUID(),
      name: 'Revoked Agent source',
      owner: sourceOwner,
    })
    const foreignAgent = await createAgent(connection.db, source.id, sourceOwner, {
      name: 'Revoked Agent',
      profileId: `prf_${'0'.repeat(25)}3`,
      profileVersion: `pfv_${'0'.repeat(25)}3`,
    })
    await addWorkspaceMembership(connection.db, source.id, host.owner, 'admin')
    expect(await removeWorkspaceMembership(connection.db, source.id, host.owner)).toBe(true)

    const { response } = await postAgentGroup(host, foreignAgent)
    await expectUnavailableWithoutAgentDisclosure(response, foreignAgent.id, source.id)
  })

  test('an authorized source-workspace admin can enlist an Agent across workspaces', async () => {
    const host = await fixture()
    const sourceOwner = await user('authorized-agent-source-owner')
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: randomUUID(),
      name: 'Authorized Agent source',
      owner: sourceOwner,
    })
    const foreignAgent = await createAgent(connection.db, source.id, sourceOwner, {
      name: 'Authorized Agent',
      profileId: `prf_${'0'.repeat(25)}4`,
      profileVersion: `pfv_${'0'.repeat(25)}4`,
    })
    await addWorkspaceMembership(connection.db, source.id, host.owner, 'admin')

    const { response } = await postAgentGroup(host, foreignAgent)
    expect(response.status).toBe(201)
  })

  test('source authorization waits for concurrent membership revocation and then denies enlistment', async () => {
    const host = await fixture()
    const sourceOwner = await user('racing-agent-source-owner')
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: randomUUID(),
      name: 'Racing Agent source',
      owner: sourceOwner,
    })
    const foreignAgent = await createAgent(connection.db, source.id, sourceOwner, {
      name: 'Racing Agent',
      profileId: `prf_${'0'.repeat(25)}5`,
      profileVersion: `pfv_${'0'.repeat(25)}5`,
    })
    await addWorkspaceMembership(connection.db, source.id, host.owner, 'admin')

    let finishRevocation!: () => void
    let announceLocked!: () => void
    const locked = new Promise<void>((resolve) => (announceLocked = resolve))
    const waitToRevoke = new Promise<void>((resolve) => (finishRevocation = resolve))
    const ownedOperations: Promise<OperationOutcome<unknown>>[] = []
    let primaryFailure: { reason: unknown } | null = null
    let waitedForAuthorizationLock = false
    try {
      const revocation = connection.db.transaction(async (transaction) => {
        const [membership] = await transaction
          .select({ id: workspaceMemberships.id })
          .from(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, source.id),
              eq(workspaceMemberships.userId, host.owner.userId)
            )
          )
          .for('update')
        expect(membership).toBeDefined()
        announceLocked()
        await waitToRevoke
        await transaction
          .delete(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, source.id),
              eq(workspaceMemberships.userId, host.owner.userId)
            )
          )
      })
      const revocationOutcome = observeOperation(revocation)
      ownedOperations.push(revocationOutcome)
      await waitForGate(locked, 'membership revocation did not reach its lock barrier')

      const request = postAgentGroup(host, foreignAgent)
      const requestOutcome = observeOperation(request)
      ownedOperations.push(requestOutcome)
      waitedForAuthorizationLock = await waitForSourceMembershipLock()
      finishRevocation()

      const revocationResult = await revocationOutcome
      if (revocationResult.status === 'rejected') throw revocationResult.reason
      const requestResult = await requestOutcome
      if (requestResult.status === 'rejected') throw requestResult.reason
      const { response } = requestResult.value
      expect(waitedForAuthorizationLock).toBe(true)
      await expectUnavailableWithoutAgentDisclosure(response, foreignAgent.id, source.id)
    } catch (reason) {
      primaryFailure = { reason }
    } finally {
      finishRevocation()
      await settleOwnedOperations(ownedOperations, primaryFailure)
    }
  })

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
          participants: [f.owner, member].map((principal) => ({
            kind: 'user',
            userId: principal.userId,
          })),
          audienceGrants: [
            audienceGrant(channelId, f.owner, `founder-${f.owner.userId}`),
            audienceGrant(channelId, member, `${grantId}_${channelId}`),
          ],
          enlistmentGrants: [],
        },
      }
    )
  }

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
          enlistmentGrants: [],
        },
      }
    )
    expect(response.status).toBe(400)
    expect(
      await connection.db.select().from(channels).where(eq(channels.id, channelId))
    ).toHaveLength(0)
  })

  test('join point over routes: a newcomer reads nothing before joining and everything after', async () => {
    const f = await fixture()
    const { channelId, response } = await createGroup(f)
    const created = (await response.json()) as { channel: { version: number } }
    expect((await postText(f, channelId, f.owner, 'before the newcomer')).status).toBe(201)
    expect(
      (await joinMember(f, channelId, created.channel.version, f.member, 'gra_join')).status
    ).toBe(200)
    expect(await readTexts(f, channelId, f.member)).not.toContain('before the newcomer')
    expect((await postText(f, channelId, f.owner, 'after the newcomer')).status).toBe(201)
    expect(await readTexts(f, channelId, f.member)).toContain('after the newcomer')
  })

  test('a revoked member reads nothing and a refused write persists nothing', async () => {
    const f = await fixture()
    const { channelId } = await createGroup(f, { audience: [f.member] })
    expect((await postText(f, channelId, f.owner, 'visible before revocation')).status).toBe(201)
    expect(await readTexts(f, channelId, f.member)).toContain('visible before revocation')
    expect(
      await revokeGroupGrant(connection.db, f.workspace.id, channelId, f.owner, {
        grantId: `gra_aud_0_${channelId}`,
        kind: 'audience',
        revokedAt: new Date().toISOString(),
      })
    ).toEqual({ revoked: true })
    const read = await call(
      messagesRoute,
      'GET',
      messagesUrl(f, channelId),
      { workspaceId: f.workspace.id, channelId },
      { as: f.member }
    )
    expect(read.status).toBe(404)
    const write = await postText(f, channelId, f.member, 'revoked route write')
    expect(write.status).toBe(404)
    expect(await countMessages(channelId, 'revoked route write')).toBe(0)
  })

  test('a foreign principal is refused on read and write with zero writes', async () => {
    const f = await fixture()
    const { channelId } = await createGroup(f, { audience: [f.member] })
    expect((await postText(f, channelId, f.owner, 'members only')).status).toBe(201)
    const read = await call(
      messagesRoute,
      'GET',
      messagesUrl(f, channelId),
      { workspaceId: f.workspace.id, channelId },
      { as: f.outsider }
    )
    expect(read.status).toBe(404)
    expect(await read.json()).toMatchObject({ code: 'workspace_unavailable' })
    const write = await postText(f, channelId, f.outsider, 'intruder write')
    expect(write.status).toBe(404)
    expect(await countMessages(channelId, 'intruder write')).toBe(0)
  })

  test('group message by id: a held pre-join message is refused, a granted one is served', async () => {
    const f = await fixture()
    const { channelId, response } = await createGroup(f)
    const created = (await response.json()) as { channel: { version: number } }
    const held = await createMessage(connection.db, f.workspace.id, channelId, f.owner, {
      bodyText: 'held pre-join',
      idempotencyKey: randomUUID(),
      sender: f.owner,
    })
    expect(
      (await joinMember(f, channelId, created.channel.version, f.member, 'gra_byid')).status
    ).toBe(200)
    const denied = await call(
      messageByIdRoute,
      'GET',
      `/api/v1/workspaces/${f.workspace.id}/messages/${held.id}`,
      { workspaceId: f.workspace.id, messageId: held.id },
      { as: f.member }
    )
    expect(denied.status).toBe(404)
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

  test('a granted plain workspace member writes to the group and reads it back', async () => {
    // Plain `member` role: no workspace.update, no project editorship. The live
    // canonical audience grant is the write authority for this group channel.
    const f = await fixture()
    const { channelId } = await createGroup(f, { audience: [f.plain] })
    const write = await postText(f, channelId, f.plain, 'plain member write')
    expect(write.status).toBe(201)
    expect(await countMessages(channelId, 'plain member write')).toBe(1)
    expect(await readTexts(f, channelId, f.plain)).toContain('plain member write')
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
