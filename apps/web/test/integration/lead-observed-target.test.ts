import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  createDatabase,
  createDirectAgentTopic,
  createLeadTurn,
  createTask,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  ensureWorkspaceLead,
  type DatabaseConnection,
} from '@adea-ai/db'
import { createLeadTurnProduct } from '../../src/server/lead-turn-product.ts'

const connectionUrl = process.env.DATABASE_URL
const adapterFor = (receipt: unknown) => ({
  lookup: async (authority: { controlPlaneWorkspaceId: string; intentId: string }) => ({
    schemaVersion: 'pi-lead-lookup/v1',
    workspaceId: authority.controlPlaneWorkspaceId,
    intentId: authority.intentId,
    receipt,
  }),
})

/**
 * Connected proof: the production product path (real Postgres, real
 * canonical reads, real snapshot composition) attaches the
 * control-plane-reported execution observation to display reads, and
 * omits it — without failing the read — for every untrusted or
 * unavailable shape. Only the CP transport is scripted (it is the
 * boundary under test); everything else is the real path, including
 * authorization, retention, and receipt checks. Runs only with an
 * isolated DATABASE_URL and the react-server condition so the server
 * composition loads:
 *
 *   DATABASE_URL=... bun test --conditions=react-server \
 *     apps/web/test/integration/lead-observed-target.test.ts
 */
describe.skipIf(!connectionUrl)('connected observed-target attach', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function fixture() {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `observed-target-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      owner: owner.principal,
      name: 'Observed targets',
      idempotencyKey: crypto.randomUUID(),
    })
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    const topic = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      { title: 'Lead DM', idempotencyKey: crypto.randomUUID() }
    )
    const task = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      { objective: 'Coordinate', title: 'Coordination' },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
    return { owner, workspace, lead, topic, task }
  }

  const observed = { sessionId: 'ses_01JABCDEF0123456789ABCDEFG', taskId: 'task-from-plan' }
  const product = (adapter?: { lookup: (authority: never) => Promise<unknown> }) =>
    createLeadTurnProduct(connection.db, adapter ? { adapter: adapter as never } : {})

  test('accepted target flows end to end with the reported observation attached', async () => {
    const f = await fixture()
    const sessionId = `session-${crypto.randomUUID()}`
    const { leadTurn } = await createLeadTurn(
      connection.db,
      f.workspace.id,
      f.topic.id,
      f.owner.principal,
      {
        bodyText: 'Requesting lead coordination.',
        idempotencyKey: crypto.randomUUID(),
        handoffTarget: {
          runtimeSessionId: sessionId,
          taskId: f.task.id,
          expectedGeneration: 3,
        },
      },
      { hostMediated: true }
    )
    expect(leadTurn.handoffTarget?.runtimeSessionId).toBe(sessionId)
    const service = product(
      adapterFor({
        dispatchId: `dispatch_${'b'.repeat(32)}`,
        executionId: 'exe_01JABCDEF0123456789ABCDEFG',
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        state: 'dispatched',
        observedTarget: observed,
      })
    )
    const latest = await service.latestForTarget(
      f.workspace.id,
      f.topic.id,
      sessionId,
      f.owner.principal.userId
    )
    expect(latest?.intentId).toBe(leadTurn.intentId)
    expect(latest?.handoffTarget?.runtimeSessionId).toBe(sessionId)
    expect(latest?.observedTarget).toEqual(observed)
  })

  test('mismatched, malformed, or failing lookups omit the fields without failing reads', async () => {
    const f = await fixture()
    const sessionId = `session-${crypto.randomUUID()}`
    await createLeadTurn(
      connection.db,
      f.workspace.id,
      f.topic.id,
      f.owner.principal,
      {
        bodyText: 'Requesting lead coordination.',
        idempotencyKey: crypto.randomUUID(),
        handoffTarget: {
          runtimeSessionId: sessionId,
          taskId: f.task.id,
          expectedGeneration: 3,
        },
      },
      { hostMediated: true }
    )
    const variants: Array<{ lookup?: (authority: never) => Promise<unknown> }> = [
      {},
      { adapter: { lookup: async () => null } },
      {
        adapter: adapterFor({
          dispatchId: `dispatch_${'b'.repeat(32)}`,
          executionId: 'exe_01JABCDEF0123456789ABCDEFG',
          attemptId: 'att_01JABCDEF0123456789ABCDEFG',
          state: 'dispatched',
          observedTarget: { sessionId: 42, taskId: null },
        }),
      },
      {
        adapter: {
          lookup: async () => {
            throw new Error('control plane unreachable')
          },
        },
      },
    ]
    for (const dependencies of variants) {
      const service = product(
        'adapter' in dependencies
          ? (dependencies as { adapter: { lookup: (authority: never) => Promise<unknown> } })
              .adapter
          : undefined
      )
      const latest = await service.latestForTarget(
        f.workspace.id,
        f.topic.id,
        sessionId,
        f.owner.principal.userId
      )
      expect(latest?.handoffTarget?.runtimeSessionId).toBe(sessionId)
      expect(latest).not.toHaveProperty('observedTarget')
    }
  })
})
