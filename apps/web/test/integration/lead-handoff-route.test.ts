import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  createDatabase,
  createDirectAgentTopic,
  createLeadTurn,
  createTask,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  ensureWorkspaceLead,
  getLatestLeadTurnForChannel,
  type DatabaseConnection,
} from '@adea-ai/db'
import {
  createTemporaryCredential,
  digestTemporaryCredential,
} from '../../src/server/temporary-session.ts'
import { withRequestScope } from '../../src/server/request-scope.ts'
import { postChannelMessage } from '../../src/server/channel-message-post.ts'

const connectionUrl = process.env.DATABASE_URL

/**
 * Direct-POST session-authority proof: the production HTTP fence (real
 * Postgres, real route handler, real principal resolution — only the
 * transport is absent because admission precedes dispatch) fails closed
 * on forged, expired, unmediated, and cross-workspace requests, and
 * retains nothing for them. Runs only with an isolated DATABASE_URL
 * and the react-server condition:
 *
 *   DATABASE_URL=... bun test --conditions=react-server \
 *     apps/web/test/integration/lead-handoff-route.test.ts
 */
const call = (
  workspaceId: string,
  channelId: string,
  authorization: string,
  body: Record<string, unknown>
) =>
  withRequestScope(() =>
    postChannelMessage(
      new Request(
        `https://app.test/api/v1/workspaces/${workspaceId}/channels/${channelId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify(body),
        }
      ),
      { workspaceId, channelId }
    )
  )

const targetFor = (taskId: string) => ({
  runtimeSessionId: `session-${crypto.randomUUID()}`,
  taskId,
  expectedGeneration: 3,
})

describe.skipIf(!connectionUrl)('direct-POST handoff fence', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function fixture() {
    const rawCredential = createTemporaryCredential()
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: await digestTemporaryCredential(rawCredential),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      owner: session.principal,
      name: 'Direct POST HQ',
      idempotencyKey: crypto.randomUUID(),
    })
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, session.principal)
    const topic = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      lead.id,
      session.principal,
      { title: 'Lead DM', idempotencyKey: crypto.randomUUID() }
    )
    const task = await createTask(
      connection.db,
      workspace.id,
      session.principal,
      { objective: 'Coordinate', title: 'Coordination' },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
    return { rawCredential, session, workspace, topic, task }
  }

  test('an unmediated target-bearing POST fails closed and retains nothing', async () => {
    const f = await fixture()
    const response = await call(f.workspace.id, f.topic.id, `Temporary ${f.rawCredential}`, {
      leadTurn: true,
      bodyText: 'Hand off to lead.',
      handoffTarget: targetFor(f.task.id),
    })
    expect(response.status).toBe(400)
    expect(
      await getLatestLeadTurnForChannel(connection.db, f.workspace.id, f.topic.id, {
        kind: 'user',
        userId: f.session.principal.userId,
      })
    ).toBeNull()
  })

  test('a forged Desktop credential fails closed before admission', async () => {
    const f = await fixture()
    const response = await call(f.workspace.id, f.topic.id, 'Desktop forged-credential', {
      leadTurn: true,
      bodyText: 'Hand off to lead.',
      handoffTarget: targetFor(f.task.id),
    })
    expect(response.status).toBe(401)
    expect(
      await getLatestLeadTurnForChannel(connection.db, f.workspace.id, f.topic.id, {
        kind: 'user',
        userId: f.session.principal.userId,
      })
    ).toBeNull()
  })

  test('an expired credential fails closed before admission', async () => {
    const f = await fixture()
    const staleRaw = createTemporaryCredential()
    await createTemporaryUserSession(connection.db, {
      credentialDigest: await digestTemporaryCredential(staleRaw),
      expiresAt: new Date(Date.now() - 60_000),
    })
    const response = await call(f.workspace.id, f.topic.id, `Temporary ${staleRaw}`, {
      leadTurn: true,
      bodyText: 'Hand off to lead.',
      handoffTarget: targetFor(f.task.id),
    })
    expect(response.status).toBe(401)
  })

  test('a valid unmediated lead turn without a target still admits', async () => {
    const f = await fixture()
    const response = await call(f.workspace.id, f.topic.id, `Temporary ${f.rawCredential}`, {
      leadTurn: true,
      bodyText: 'Requesting lead coordination.',
    })
    expect(response.status).toBe(201)
    const payload = (await response.json()) as { leadTurn?: { intentId?: string } }
    expect(typeof payload.leadTurn?.intentId).toBe('string')
  })

  test('a repeated admission with the same key returns the same receipt', async () => {
    const f = await fixture()
    const key = crypto.randomUUID()
    const once = await withRequestScope(() =>
      postChannelMessage(
        new Request(
          `https://app.test/api/v1/workspaces/${f.workspace.id}/channels/${f.topic.id}/messages`,
          {
            method: 'POST',
            headers: {
              authorization: `Temporary ${f.rawCredential}`,
              'content-type': 'application/json',
              'idempotency-key': key,
            },
            body: JSON.stringify({ leadTurn: true, bodyText: 'Requesting lead coordination.' }),
          }
        ),
        { workspaceId: f.workspace.id, channelId: f.topic.id }
      )
    )
    const twice = await withRequestScope(() =>
      postChannelMessage(
        new Request(
          `https://app.test/api/v1/workspaces/${f.workspace.id}/channels/${f.topic.id}/messages`,
          {
            method: 'POST',
            headers: {
              authorization: `Temporary ${f.rawCredential}`,
              'content-type': 'application/json',
              'idempotency-key': key,
            },
            body: JSON.stringify({ leadTurn: true, bodyText: 'Requesting lead coordination.' }),
          }
        ),
        { workspaceId: f.workspace.id, channelId: f.topic.id }
      )
    )
    expect(once.status).toBe(201)
    expect(twice.status).toBe(201)
    const first = (await once.json()) as { leadTurn?: { intentId?: string } }
    const second = (await twice.json()) as { leadTurn?: { intentId?: string } }
    expect(second.leadTurn?.intentId).toBe(first.leadTurn?.intentId)
  })

  test('a cross-workspace channel POST fails closed', async () => {
    const f = await fixture()
    const otherRaw = createTemporaryCredential()
    const otherSession = await createTemporaryUserSession(connection.db, {
      credentialDigest: await digestTemporaryCredential(otherRaw),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace: otherWorkspace } = await createWorkspaceWithOwner(connection.db, {
      owner: otherSession.principal,
      name: 'Elsewhere',
      idempotencyKey: crypto.randomUUID(),
    })
    const otherLead = await ensureWorkspaceLead(
      connection.db,
      otherWorkspace.id,
      otherSession.principal
    )
    const otherTopic = await createDirectAgentTopic(
      connection.db,
      otherWorkspace.id,
      otherLead.id,
      otherSession.principal,
      { title: 'Other DM', idempotencyKey: crypto.randomUUID() }
    )
    // f.session belongs to the first workspace only: posting into the
    // other workspace's channel must fail even with a wellformed body.
    const response = await call(otherWorkspace.id, otherTopic.id, `Temporary ${f.rawCredential}`, {
      leadTurn: true,
      bodyText: 'Requesting lead coordination.',
    })
    expect(response.status).not.toBe(201)
  })

  test('a task from another workspace fails closed', async () => {
    const f = await fixture()
    const otherRaw = createTemporaryCredential()
    const otherSession = await createTemporaryUserSession(connection.db, {
      credentialDigest: await digestTemporaryCredential(otherRaw),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace: otherWorkspace } = await createWorkspaceWithOwner(connection.db, {
      owner: otherSession.principal,
      name: 'Far away',
      idempotencyKey: crypto.randomUUID(),
    })
    const foreignTask = await createTask(
      connection.db,
      otherWorkspace.id,
      otherSession.principal,
      { objective: 'Elsewhere', title: 'Foreign' },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
    // Structural check first: the same forgery at the database fence.
    await expect(
      createLeadTurn(
        connection.db,
        f.workspace.id,
        f.topic.id,
        f.session.principal,
        {
          bodyText: 'Hand off to lead.',
          idempotencyKey: crypto.randomUUID(),
          handoffTarget: {
            runtimeSessionId: `session-${crypto.randomUUID()}`,
            taskId: foreignTask.id,
            expectedGeneration: 3,
          },
        },
        { hostMediated: true }
      )
    ).rejects.toThrow('Task unavailable')
    expect(
      await getLatestLeadTurnForChannel(connection.db, f.workspace.id, f.topic.id, {
        kind: 'user',
        userId: f.session.principal.userId,
      })
    ).toBeNull()
  })
})
