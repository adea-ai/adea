import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { ensureWorkspaceLead } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createDirectAgentTopic } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { createLeadTurn, getLatestLeadTurnForTarget } from '../../src/lead-turns'
import { leadTurnIntents } from '../../src/schema/lead-turns'
import { createTask } from '../../src/tasks'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const selection = (revision: number) => ({
  lead: {
    selectionRef: `msel_${'a'.repeat(32)}`,
    selectionRevision: revision,
  },
})

const connectionUrl = process.env.DATABASE_URL
describe.skipIf(!connectionUrl)('lead-turn structured handoff target', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function fixture() {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `handoff-target-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      owner: owner.principal,
      name: 'Handoff targets',
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
    const target = (session: string, generation: number) => ({
      runtimeSessionId: session,
      taskId: task.id,
      expectedGeneration: generation,
    })
    // The trusted path: admissions arrive over the authenticated
    // desktop-host channel (the route asserts the validated Desktop
    // credential; direct callers pass the flag only in these tests).
    const admit = (
      session: string,
      generation: number,
      channelId = topic.id,
      extra: Record<string, unknown> = {}
    ) =>
      createLeadTurn(
        connection.db,
        workspace.id,
        channelId,
        owner.principal,
        {
          bodyText: `Requesting lead coordination for direct session ${session}.`,
          idempotencyKey: crypto.randomUUID(),
          handoffTarget: target(session, generation),
          ...extra,
        },
        { hostMediated: true }
      )
    const bypass = (session: string, generation: number, extra: Record<string, unknown> = {}) =>
      createLeadTurn(connection.db, workspace.id, topic.id, owner.principal, {
        bodyText: `Requesting lead coordination for direct session ${session}.`,
        idempotencyKey: crypto.randomUUID(),
        handoffTarget: target(session, generation),
        ...extra,
      })
    return { owner, workspace, lead, topic, task, target, admit, bypass }
  }

  test('admission retains the structured target and returns it on the receipt', async () => {
    const f = await fixture()
    const { leadTurn } = await f.admit('target-session-a', 3)
    expect(leadTurn.handoffTarget).toEqual({
      runtimeSessionId: 'target-session-a',
      taskId: f.task.id,
      observedGeneration: 3,
    })
    const [row] = await connection.db
      .select()
      .from(leadTurnIntents)
      .where(eq(leadTurnIntents.id, leadTurn.intentId))
    expect(row).toMatchObject({
      handoffTargetSessionId: 'target-session-a',
      handoffTargetGeneration: 3,
      handoffTargetTaskId: f.task.id,
    })
  })

  test('two sessions sharing one task keep exact bindings', async () => {
    const f = await fixture()
    const first = await f.admit('target-session-a', 3)
    const second = await f.admit('target-session-b', 3)
    expect(second.leadTurn.intentId).not.toBe(first.leadTurn.intentId)
    const forA = await getLatestLeadTurnForTarget(
      connection.db,
      f.workspace.id,
      f.topic.id,
      'target-session-a',
      f.owner.principal
    )
    const forB = await getLatestLeadTurnForTarget(
      connection.db,
      f.workspace.id,
      f.topic.id,
      'target-session-b',
      f.owner.principal
    )
    expect(forA?.intentId).toBe(first.leadTurn.intentId)
    expect(forA?.handoffTarget?.runtimeSessionId).toBe('target-session-a')
    expect(forB?.intentId).toBe(second.leadTurn.intentId)
    expect(forB?.handoffTarget?.runtimeSessionId).toBe('target-session-b')
    const forUnknown = await getLatestLeadTurnForTarget(
      connection.db,
      f.workspace.id,
      f.topic.id,
      'target-session-absent',
      f.owner.principal
    )
    expect(forUnknown).toBeNull()
  })

  test('a newer unrelated channel turn never overrides the exact binding', async () => {
    const f = await fixture()
    const first = await f.admit('target-session-a', 3)
    const other = await createDirectAgentTopic(
      connection.db,
      f.workspace.id,
      f.lead.id,
      f.owner.principal,
      { title: 'Other DM', idempotencyKey: crypto.randomUUID() }
    )
    await f.admit('target-session-other', 7, other.id)
    const retained = await getLatestLeadTurnForTarget(
      connection.db,
      f.workspace.id,
      f.topic.id,
      'target-session-a',
      f.owner.principal
    )
    expect(retained?.intentId).toBe(first.leadTurn.intentId)
  })

  test('reload after unknown outcome recovers the retained intent instead of minting', async () => {
    const f = await fixture()
    const first = await f.admit('target-session-a', 3)
    // The client lost its request identity (eviction/reload): a fresh key
    // with the same exact target and generation must recover, not duplicate.
    const recovered = await f.admit('target-session-a', 3)
    expect(recovered.leadTurn.intentId).toBe(first.leadTurn.intentId)
    const rows = await connection.db
      .select({ id: leadTurnIntents.id })
      .from(leadTurnIntents)
      .where(
        and(
          eq(leadTurnIntents.workspaceId, f.workspace.id),
          eq(leadTurnIntents.channelId, f.topic.id)
        )
      )
    expect(rows).toHaveLength(1)
  })

  test('reads return the latest retained request for tracking', async () => {
    // Request tracking only: the latest retained request reads back with
    // its claim intact. This orders requests for display and recovery; it
    // confers no coordination, which needs the effect boundary (proven at
    // the derivation layer, where retained claims alone never bind).
    const f = await fixture()
    const older = await f.admit('target-session-a', 3)
    const newer = await f.admit('target-session-a', 5)
    expect(newer.leadTurn.intentId).not.toBe(older.leadTurn.intentId)
    const current = await getLatestLeadTurnForTarget(
      connection.db,
      f.workspace.id,
      f.topic.id,
      'target-session-a',
      f.owner.principal
    )
    expect(current?.intentId).toBe(newer.leadTurn.intentId)
    expect(current?.handoffTarget?.observedGeneration).toBe(5)
  })

  test('same session and generation with a different task fails closed', async () => {
    const f = await fixture()
    await f.admit('target-session-a', 3)
    const other = await createTask(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      { objective: 'Other', title: 'Other' },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
    await expect(
      createLeadTurn(
        connection.db,
        f.workspace.id,
        f.topic.id,
        f.owner.principal,
        {
          bodyText: 'Requesting lead coordination.',
          idempotencyKey: crypto.randomUUID(),
          handoffTarget: {
            runtimeSessionId: 'target-session-a',
            taskId: other.id,
            expectedGeneration: 3,
          },
        },
        { hostMediated: true }
      )
    ).rejects.toThrow('target mismatch')
  })

  test('a task from another workspace fails closed', async () => {
    const f = await fixture()
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `handoff-outsider-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace: other } = await createWorkspaceWithOwner(connection.db, {
      owner: outsider.principal,
      name: 'Elsewhere',
      idempotencyKey: crypto.randomUUID(),
    })
    const foreign = await createTask(
      connection.db,
      other.id,
      outsider.principal,
      { objective: 'Foreign', title: 'Foreign' },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
    await expect(
      createLeadTurn(
        connection.db,
        f.workspace.id,
        f.topic.id,
        f.owner.principal,
        {
          bodyText: 'Requesting lead coordination.',
          idempotencyKey: crypto.randomUUID(),
          handoffTarget: {
            runtimeSessionId: 'target-session-a',
            taskId: foreign.id,
            expectedGeneration: 3,
          },
        },
        { hostMediated: true }
      )
    ).rejects.toThrow()
  })

  test('concurrent same-target admissions commit exactly one intent', async () => {
    // Serialization, not the unique index: the channel FOR UPDATE lock
    // orders same-channel admissions, so every loser finds the winner in
    // recovery. The partial unique target index stays as the backstop.
    const f = await fixture()
    const results = await Promise.all(
      Array.from({ length: 4 }, () => f.admit('target-session-a', 3))
    )
    expect(new Set(results.map((r) => r.leadTurn.intentId)).size).toBe(1)
    const rows = await connection.db
      .select({ id: leadTurnIntents.id })
      .from(leadTurnIntents)
      .where(
        and(
          eq(leadTurnIntents.workspaceId, f.workspace.id),
          eq(leadTurnIntents.channelId, f.topic.id)
        )
      )
    expect(rows).toHaveLength(1)
  })

  test('malformed targets and phantom tasks fail closed', async () => {
    const f = await fixture()
    const base = {
      bodyText: 'Requesting lead coordination.',
      idempotencyKey: crypto.randomUUID(),
    }
    const principal = f.owner.principal
    await expect(
      createLeadTurn(
        connection.db,
        f.workspace.id,
        f.topic.id,
        principal,
        {
          ...base,
          idempotencyKey: crypto.randomUUID(),
          handoffTarget: { runtimeSessionId: '   ', taskId: f.task.id, expectedGeneration: 3 },
        },
        { hostMediated: true }
      )
    ).rejects.toThrow()
    await expect(
      createLeadTurn(
        connection.db,
        f.workspace.id,
        f.topic.id,
        principal,
        {
          ...base,
          idempotencyKey: crypto.randomUUID(),
          handoffTarget: {
            runtimeSessionId: 'target-session-a',
            taskId: f.task.id,
            expectedGeneration: -1,
          },
        },
        { hostMediated: true }
      )
    ).rejects.toThrow()
    await expect(
      createLeadTurn(
        connection.db,
        f.workspace.id,
        f.topic.id,
        principal,
        {
          ...base,
          idempotencyKey: crypto.randomUUID(),
          handoffTarget: {
            runtimeSessionId: 'target-session-a',
            taskId: '00000000-0000-4000-8000-ffffffffffff',
            expectedGeneration: 3,
          },
        },
        { hostMediated: true }
      )
    ).rejects.toThrow()
  })

  test('direct bypass without host mediation retains nothing', async () => {
    // The attacker path: a fully authenticated principal calling admission
    // directly, bypassing the desktop host (forged session, task, and a
    // fabricated high generation). Without host mediation the claim fails
    // closed before any row exists — there is nothing to recover, order,
    // or display.
    const f = await fixture()
    await expect(f.bypass('target-session-a', 9999)).rejects.toThrow('host mediation')
    await expect(f.bypass('target-session-a', 3)).rejects.toThrow('host mediation')
    const rows = await connection.db
      .select({ id: leadTurnIntents.id })
      .from(leadTurnIntents)
      .where(eq(leadTurnIntents.workspaceId, f.workspace.id))
    expect(rows).toHaveLength(0)
  })

  test('a retained forged future reads as a request and coordinates nothing', async () => {
    const f = await fixture()
    // Unmediated forgery retains nothing at all.
    await expect(f.bypass('target-session-a', 9999)).rejects.toThrow('host mediation')
    // A desktop-credentialed bypass of client preflight IS retained (the
    // server cannot tell it from an honest request): it reads back as the
    // latest tracked request. That is ALL it ever becomes — coordination
    // needs a runtime-validated execution binding no retained claim
    // carries, proven unbound at the derivation layer for this exact
    // shape (forged future, no observation).
    const forged = await f.admit('target-session-a', 9999)
    const current = await getLatestLeadTurnForTarget(
      connection.db,
      f.workspace.id,
      f.topic.id,
      'target-session-a',
      f.owner.principal
    )
    expect(current?.intentId).toBe(forged.leadTurn.intentId)
    expect(current?.handoffTarget?.observedGeneration).toBe(9999)
  })

  test('a changed explicit choice replays as a conflict, never a silent return', async () => {
    const f = await fixture()
    const first = await f.admit('target-session-a', 3, f.topic.id, {
      requestedModelSelections: selection(1),
    })
    // Same complete target and same choice: the retained receipt returns.
    const replay = await f.admit('target-session-a', 3, f.topic.id, {
      requestedModelSelections: selection(1),
    })
    expect(replay.leadTurn.intentId).toBe(first.leadTurn.intentId)
    // Same target with a changed explicit choice: conflict, like the
    // message-idempotency path reports — never the old receipt.
    await expect(
      f.admit('target-session-a', 3, f.topic.id, { requestedModelSelections: selection(2) })
    ).rejects.toThrow('model selection conflict')
  })

  test('legacy admissions without a target keep working', async () => {
    const f = await fixture()
    const { leadTurn } = await createLeadTurn(
      connection.db,
      f.workspace.id,
      f.topic.id,
      f.owner.principal,
      { bodyText: 'Canonical user content', idempotencyKey: crypto.randomUUID() }
    )
    expect(leadTurn.handoffTarget).toBeUndefined()
    expect(leadTurn.state).toBe('blocked')
  })
})
