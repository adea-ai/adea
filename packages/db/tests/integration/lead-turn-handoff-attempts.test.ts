import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  addWorkspaceMembership,
  createDatabase,
  createDirectAgentTopic,
  createLeadTurn,
  createTask,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  ensureWorkspaceLead,
  getLatestLeadTurnForChannel,
  getLatestLeadTurnForTarget,
  type DatabaseConnection,
} from '@adea-ai/db'

const connectionUrl = process.env.DATABASE_URL

/**
 * Handoff-attempt semantics proof: stale generations mint anew but never
 * surface as latest, exact repeats dedupe to one retained intent, and a
 * task the principal cannot see (hidden project or foreign workspace)
 * fails closed. Runs only with an isolated DATABASE_URL:
 *
 *   DATABASE_URL=... bun test --conditions=react-server \
 *     packages/db/tests/integration/lead-turn-handoff-attempts.test.ts
 */
describe.skipIf(!connectionUrl)('handoff attempt semantics', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function fixture() {
    const ownerSession = await createTemporaryUserSession(connection.db, {
      credentialDigest: `attempts-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const memberSession = await createTemporaryUserSession(connection.db, {
      credentialDigest: `attempts-member-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      owner: ownerSession.principal,
      name: 'Attempt HQ',
      idempotencyKey: crypto.randomUUID(),
    })
    await addWorkspaceMembership(connection.db, workspace.id, memberSession.principal, 'member')
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, ownerSession.principal)
    const topic = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      lead.id,
      ownerSession.principal,
      { title: 'Lead DM', idempotencyKey: crypto.randomUUID() }
    )
    const task = await createTask(
      connection.db,
      workspace.id,
      ownerSession.principal,
      { objective: 'Coordinate', title: 'Coordination' },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
    return { ownerSession, memberSession, workspace, lead, topic, task }
  }

  const admit = (
    workspaceId: string,
    channelId: string,
    principal: { kind: 'user'; userId: string },
    target: { runtimeSessionId: string; taskId: string; expectedGeneration: number }
  ) =>
    createLeadTurn(
      connection.db,
      workspaceId,
      channelId,
      principal,
      {
        bodyText: 'Hand off to lead.',
        idempotencyKey: crypto.randomUUID(),
        handoffTarget: target,
      },
      { hostMediated: true }
    )

  test('a stale generation mints anew but never surfaces as latest', async () => {
    const f = await fixture()
    const sessionId = `session-${crypto.randomUUID()}`
    const fresh = await admit(f.workspace.id, f.topic.id, f.ownerSession.principal, {
      runtimeSessionId: sessionId,
      taskId: f.task.id,
      expectedGeneration: 5,
    })
    const stale = await admit(f.workspace.id, f.topic.id, f.ownerSession.principal, {
      runtimeSessionId: sessionId,
      taskId: f.task.id,
      expectedGeneration: 3,
    })
    // A different generation is a new attempt row, never a rejection and
    // never an overwrite: ordering, not ground truth.
    expect(stale.leadTurn.intentId).not.toBe(fresh.leadTurn.intentId)
    const tracked = await getLatestLeadTurnForTarget(
      connection.db,
      f.workspace.id,
      f.topic.id,
      sessionId,
      { kind: 'user', userId: f.ownerSession.principal.userId }
    )
    expect(tracked?.intentId).toBe(fresh.leadTurn.intentId)
    expect(tracked?.handoffTarget?.observedGeneration).toBe(5)
    // Channel latest follows admission recency (message sequence), so it
    // surfaces the stale row here — and only here. Nothing downstream
    // coordinates off it: the derivation names the stale generation
    // against the live transcript and offers re-request instead.
    const latest = await getLatestLeadTurnForChannel(connection.db, f.workspace.id, f.topic.id, {
      kind: 'user',
      userId: f.ownerSession.principal.userId,
    })
    expect(latest?.intentId).toBe(stale.leadTurn.intentId)
    expect(latest?.handoffTarget?.observedGeneration).toBe(3)
  })

  test('an exact repeat dedupes to the retained intent', async () => {
    const f = await fixture()
    const sessionId = `session-${crypto.randomUUID()}`
    const target = {
      runtimeSessionId: sessionId,
      taskId: f.task.id,
      expectedGeneration: 5,
    }
    const first = await admit(f.workspace.id, f.topic.id, f.ownerSession.principal, target)
    const second = await admit(f.workspace.id, f.topic.id, f.ownerSession.principal, target)
    expect(second.leadTurn.intentId).toBe(first.leadTurn.intentId)
    expect(second.message.id).toBe(first.message.id)
  })

  test('a non-privileged member fails closed before anything is retained', async () => {
    const f = await fixture()
    // Plain members lack runtime.invoke, so they never reach target
    // resolution: the claim fails closed at admission authority and
    // retains nothing, even from the member's own DM.
    const memberTopic = await createDirectAgentTopic(
      connection.db,
      f.workspace.id,
      f.lead.id,
      f.memberSession.principal,
      { title: 'Member DM', idempotencyKey: crypto.randomUUID() }
    )
    const sessionId = `session-${crypto.randomUUID()}`
    await expect(
      admit(f.workspace.id, memberTopic.id, f.memberSession.principal, {
        runtimeSessionId: sessionId,
        taskId: f.task.id,
        expectedGeneration: 3,
      })
    ).rejects.toThrow('Lead turn unavailable')
    expect(
      await getLatestLeadTurnForTarget(connection.db, f.workspace.id, memberTopic.id, sessionId, {
        kind: 'user',
        userId: f.memberSession.principal.userId,
      })
    ).toBeNull()
    // Control: the privileged owner admits the same claim.
    const admitted = await admit(f.workspace.id, f.topic.id, f.ownerSession.principal, {
      runtimeSessionId: sessionId,
      taskId: f.task.id,
      expectedGeneration: 3,
    })
    expect(admitted.leadTurn.handoffTarget?.taskId).toBe(f.task.id)
  })
})
