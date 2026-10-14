import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { ensureWorkspaceLead } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createDirectAgentTopic, createMessage } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { createLeadTurn, getLatestLeadTurnForTarget } from '../../src/lead-turns'
import {
  observeLeadTurnRuntime,
  prepareLeadTurnRuntime,
  requestLeadTurnCancellation,
} from '../../src/lead-turn-runtime'
import { leadTurnRuntime } from '../../src/schema/lead-turn-runtime'
import { messages } from '../../src/schema/conversations'
import { workspaceMemberships, workspaces } from '../../src/schema/workspaces'
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
    // server cannot tell it from an honest request): it reads back as a
    // tracked request with its claim intact. That is ALL it ever becomes
    // — coordination needs a runtime-validated execution binding no
    // retained claim carries, proven unbound at the derivation layer for
    // this exact shape (forged future, no observation). Reads order
    // retained requests by generation-then-sequence for tracking only;
    // neither order confers coordination.
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

  test('task UUID casing preserves same-key replay and fresh-key target recovery', async () => {
    const f = await fixture()
    const target = f.target('target-session-a', 3)
    const key = crypto.randomUUID()
    const post = (taskId: string, idempotencyKey = key) =>
      createLeadTurn(
        connection.db,
        f.workspace.id,
        f.topic.id,
        f.owner.principal,
        {
          bodyText: 'Requesting lead coordination.',
          idempotencyKey,
          handoffTarget: { ...target, taskId },
        },
        { hostMediated: true }
      )
    const first = await post(target.taskId.toUpperCase())
    expect((await post(target.taskId.toUpperCase())).leadTurn.intentId).toBe(
      first.leadTurn.intentId
    )
    expect((await post(target.taskId)).leadTurn.intentId).toBe(first.leadTurn.intentId)
    expect((await post(target.taskId.toUpperCase(), crypto.randomUUID())).leadTurn.intentId).toBe(
      first.leadTurn.intentId
    )
    expect(first.leadTurn.handoffTarget?.taskId).toBe(target.taskId)
  })

  for (const retained of [false, true]) {
    test(`a plain-message key rejects targeted admission with retained destination: ${retained}`, async () => {
      const f = await fixture()
      const key = crypto.randomUUID()
      const plain = await createMessage(
        connection.db,
        f.workspace.id,
        f.topic.id,
        f.owner.principal,
        {
          bodyText: 'Requesting lead coordination.',
          idempotencyKey: key,
          sender: f.owner.principal,
        }
      )
      if (retained) await f.admit('target-session-a', 3)
      await expect(
        createLeadTurn(
          connection.db,
          f.workspace.id,
          f.topic.id,
          f.owner.principal,
          {
            bodyText: 'Requesting lead coordination.',
            idempotencyKey: key,
            handoffTarget: f.target('target-session-a', 3),
          },
          { hostMediated: true }
        )
      ).rejects.toThrow('Message idempotency conflict')
      const rows = await connection.db
        .select({ id: leadTurnIntents.id })
        .from(leadTurnIntents)
        .where(
          and(
            eq(leadTurnIntents.workspaceId, f.workspace.id),
            eq(leadTurnIntents.channelId, f.topic.id)
          )
        )
      expect(rows).toHaveLength(retained ? 1 : 0)
      expect(
        (
          await createMessage(connection.db, f.workspace.id, f.topic.id, f.owner.principal, {
            bodyText: 'Requesting lead coordination.',
            idempotencyKey: key,
            sender: f.owner.principal,
          })
        ).id
      ).toBe(plain.id)
    })
  }

  for (const change of [
    'session',
    'task',
    'generation',
    'add-target',
    'remove-target',
    'retained-destination',
  ] as const) {
    test(`the same message key rejects a changed handoff target: ${change}`, async () => {
      const f = await fixture()
      const original = change === 'add-target' ? undefined : f.target('target-session-a', 3)
      let changed = original && { ...original }
      if (change === 'session' || change === 'retained-destination')
        changed = f.target('target-session-b', 3)
      if (change === 'generation') changed = f.target('target-session-a', 4)
      if (change === 'add-target') changed = f.target('target-session-a', 3)
      if (change === 'remove-target') changed = undefined
      if (change === 'task') {
        const other = await createTask(
          connection.db,
          f.workspace.id,
          f.owner.principal,
          { objective: 'Other', title: 'Other' },
          { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
        )
        changed = { ...f.target('target-session-a', 3), taskId: other.id }
      }
      const key = crypto.randomUUID()
      const post = (handoffTarget: typeof original, idempotencyKey = key) =>
        createLeadTurn(
          connection.db,
          f.workspace.id,
          f.topic.id,
          f.owner.principal,
          {
            // Keep the message payload identical: only the intent target changes.
            bodyText: 'Requesting lead coordination.',
            idempotencyKey,
            ...(handoffTarget ? { handoffTarget } : {}),
          },
          { hostMediated: true }
        )
      const first = await post(original)
      const replay = await post(original)
      expect(replay.leadTurn.intentId).toBe(first.leadTurn.intentId)
      if (change === 'retained-destination') await post(changed, crypto.randomUUID())
      await expect(post(changed)).rejects.toThrow('Lead turn target mismatch')
      const rows = await connection.db
        .select({ id: leadTurnIntents.id })
        .from(leadTurnIntents)
        .where(
          and(
            eq(leadTurnIntents.workspaceId, f.workspace.id),
            eq(leadTurnIntents.channelId, f.topic.id)
          )
        )
      expect(rows).toHaveLength(change === 'retained-destination' ? 2 : 1)
    })
  }

  // Acceptance for the same-generation terminal successor. Adapter observations below are
  // synthetic fixtures, never evidence of CP935 target-bound effects or session authority.
  async function observeFixtureRuntime(
    f: Awaited<ReturnType<typeof fixture>>,
    intentId: string,
    state: 'completed' | 'failed' | 'running' | 'unknown' | 'cancelling'
  ) {
    const [workspace] = await connection.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, f.workspace.id))
    const suffix = crypto
      .randomUUID()
      .replaceAll('-', '')
      .slice(0, 26)
      .toUpperCase()
      .replace(/[ILOU]/g, '0')
    const prepared = {
      workspaceId: workspace!.controlPlaneWorkspaceId,
      intentId,
      executionId: `exe_${suffix}`,
      attemptId: `att_${suffix}`,
      selectionRef: `msel_${crypto.randomUUID().replaceAll('-', '')}`,
      selectionRevision: 1,
      preparationRef: `prep_${crypto.randomUUID().replaceAll('-', '')}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }
    await prepareLeadTurnRuntime(
      connection.db,
      f.workspace.id,
      intentId,
      f.owner.principal,
      prepared
    )
    const observation = {
      intentId,
      executionId: prepared.executionId,
      attemptId: prepared.attemptId,
      dispatchId: `dispatch_${crypto.randomUUID().replaceAll('-', '')}`,
      runtimeSessionId: `ses_${suffix}`,
      state,
      observedAt: new Date().toISOString(),
    }
    await observeLeadTurnRuntime(
      connection.db,
      f.workspace.id,
      intentId,
      f.owner.principal,
      observation
    )
    const [persisted] = await connection.db
      .select()
      .from(leadTurnRuntime)
      .where(eq(leadTurnRuntime.intentId, intentId))
    expect(persisted).toMatchObject({
      intentId,
      executionId: observation.executionId,
      attemptId: observation.attemptId,
      dispatchId: observation.dispatchId,
      runtimeSessionId: observation.runtimeSessionId,
      state,
      cancelRequestedAt: null,
    })
    expect(persisted?.observedAt?.toISOString()).toBe(observation.observedAt)
  }

  async function retainedHistory(intentId: string) {
    const [intent] = await connection.db
      .select()
      .from(leadTurnIntents)
      .where(eq(leadTurnIntents.id, intentId))
    const [runtime] = await connection.db
      .select()
      .from(leadTurnRuntime)
      .where(eq(leadTurnRuntime.intentId, intentId))
    const [message] = await connection.db
      .select()
      .from(messages)
      .where(eq(messages.id, intent!.messageId))
    return { intent, runtime, message }
  }

  async function targetRows(f: Awaited<ReturnType<typeof fixture>>) {
    return connection.db
      .select()
      .from(leadTurnIntents)
      .where(
        and(
          eq(leadTurnIntents.workspaceId, f.workspace.id),
          eq(leadTurnIntents.channelId, f.topic.id),
          eq(leadTurnIntents.handoffTargetSessionId, 'terminal-target'),
          eq(leadTurnIntents.handoffTargetGeneration, 3)
        )
      )
  }

  for (const state of ['completed', 'failed'] as const) {
    test(`fresh ${state} request creates a successor and retains predecessor history`, async () => {
      const f = await fixture()
      const predecessor = await f.admit('terminal-target', 3)
      await observeFixtureRuntime(f, predecessor.leadTurn.intentId, state)
      const before = await retainedHistory(predecessor.leadTurn.intentId)
      const successor = await f.admit('terminal-target', 3)
      expect(successor.leadTurn.intentId).not.toBe(predecessor.leadTurn.intentId)
      expect(successor.message.id).not.toBe(predecessor.message.id)
      expect(successor.leadTurn.handoffTarget).toEqual(predecessor.leadTurn.handoffTarget)
      expect(await retainedHistory(predecessor.leadTurn.intentId)).toEqual(before)
      expect(await targetRows(f)).toHaveLength(2)
      expect(
        await getLatestLeadTurnForTarget(
          connection.db,
          f.workspace.id,
          f.topic.id,
          'terminal-target',
          f.owner.principal
        )
      ).toMatchObject({ intentId: successor.leadTurn.intentId })
    })

    test(`historical same-key replay after ${state} successor returns the predecessor`, async () => {
      const f = await fixture()
      const key = crypto.randomUUID()
      const predecessor = await f.admit('terminal-target', 3, f.topic.id, { idempotencyKey: key })
      await observeFixtureRuntime(f, predecessor.leadTurn.intentId, state)
      const successorKey = crypto.randomUUID()
      const successor = await f.admit('terminal-target', 3, f.topic.id, {
        idempotencyKey: successorKey,
      })
      // This prerequisite intentionally fails today; old-intent dedupe cannot qualify historical replay.
      expect(successor.leadTurn.intentId).not.toBe(predecessor.leadTurn.intentId)
      const predecessorBeforeReplay = await retainedHistory(predecessor.leadTurn.intentId)
      const successorBeforeReplay = await retainedHistory(successor.leadTurn.intentId)
      const replay = await f.admit('terminal-target', 3, f.topic.id, { idempotencyKey: key })
      expect(replay.leadTurn.intentId).toBe(predecessor.leadTurn.intentId)
      expect(replay.message.id).toBe(predecessor.message.id)
      const successorReplay = await f.admit('terminal-target', 3, f.topic.id, {
        idempotencyKey: successorKey,
      })
      expect(successorReplay.leadTurn.intentId).toBe(successor.leadTurn.intentId)
      expect(await targetRows(f)).toHaveLength(2)
      expect(await retainedHistory(predecessor.leadTurn.intentId)).toEqual(predecessorBeforeReplay)
      expect(await retainedHistory(successor.leadTurn.intentId)).toEqual(successorBeforeReplay)
      expect(
        await getLatestLeadTurnForTarget(
          connection.db,
          f.workspace.id,
          f.topic.id,
          'terminal-target',
          f.owner.principal
        )
      ).toMatchObject({ intentId: successor.leadTurn.intentId })
    })

    test(`concurrent fresh ${state} requests converge on one successor`, async () => {
      const f = await fixture()
      const predecessor = await f.admit('terminal-target', 3)
      await observeFixtureRuntime(f, predecessor.leadTurn.intentId, state)
      const before = await retainedHistory(predecessor.leadTurn.intentId)
      const results = await Promise.all(
        Array.from({ length: 4 }, () => f.admit('terminal-target', 3))
      )
      expect(new Set(results.map((result) => result.leadTurn.intentId)).size).toBe(1)
      expect(new Set(results.map((result) => result.message.id)).size).toBe(1)
      expect(results[0]!.leadTurn.intentId).not.toBe(predecessor.leadTurn.intentId)
      expect(await targetRows(f)).toHaveLength(2)
      expect(
        await connection.db.select().from(messages).where(eq(messages.channelId, f.topic.id))
      ).toHaveLength(2)
      expect(await retainedHistory(predecessor.leadTurn.intentId)).toEqual(before)
    })
  }

  for (const state of ['running', 'unknown', 'cancelling', 'cancel-requested'] as const) {
    test(`successor safety: ${state} refuses a new intent and recovers the retained request`, async () => {
      const f = await fixture()
      const predecessor = await f.admit('terminal-target', 3)
      await observeFixtureRuntime(
        f,
        predecessor.leadTurn.intentId,
        state === 'cancel-requested' ? 'running' : state
      )
      if (state === 'cancel-requested')
        await requestLeadTurnCancellation(
          connection.db,
          f.workspace.id,
          predecessor.leadTurn.intentId,
          f.owner.principal
        )
      const before = await retainedHistory(predecessor.leadTurn.intentId)
      expect(before.runtime?.state).toBe(state === 'cancel-requested' ? 'running' : state)
      if (state === 'cancel-requested')
        expect(before.runtime?.cancelRequestedAt).toBeInstanceOf(Date)
      else expect(before.runtime?.cancelRequestedAt).toBeNull()
      const retry = await f.admit('terminal-target', 3)
      expect(retry.leadTurn.intentId).toBe(predecessor.leadTurn.intentId)
      expect(retry.message.id).toBe(predecessor.message.id)
      expect(await targetRows(f)).toHaveLength(1)
      expect(await retainedHistory(predecessor.leadTurn.intentId)).toEqual(before)
    })
  }

  test('successor safety: completed history never permits a same-generation task mismatch', async () => {
    const f = await fixture()
    const predecessor = await f.admit('terminal-target', 3)
    await observeFixtureRuntime(f, predecessor.leadTurn.intentId, 'completed')
    const before = await retainedHistory(predecessor.leadTurn.intentId)
    const otherTask = await createTask(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      { objective: 'Different target', title: 'Other task' },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
    await expect(
      f.admit('terminal-target', 3, f.topic.id, {
        handoffTarget: { ...f.target('terminal-target', 3), taskId: otherTask.id },
      })
    ).rejects.toThrow('Lead turn target mismatch')
    expect(await targetRows(f)).toHaveLength(1)
    expect(await retainedHistory(predecessor.leadTurn.intentId)).toEqual(before)
  })

  test('successor safety: completed history does not bypass revoked workspace authority', async () => {
    const f = await fixture()
    const predecessorKey = crypto.randomUUID()
    const predecessor = await f.admit('terminal-target', 3, f.topic.id, {
      idempotencyKey: predecessorKey,
    })
    await observeFixtureRuntime(f, predecessor.leadTurn.intentId, 'completed')
    const before = await retainedHistory(predecessor.leadTurn.intentId)
    await connection.db
      .delete(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, f.workspace.id),
          eq(workspaceMemberships.userId, f.owner.principal.userId)
        )
      )
    await expect(f.admit('terminal-target', 3)).rejects.toThrow('Lead turn unavailable')
    await expect(
      f.admit('terminal-target', 3, f.topic.id, { idempotencyKey: predecessorKey })
    ).rejects.toThrow('Lead turn unavailable')
    expect(await targetRows(f)).toHaveLength(1)
    expect(await retainedHistory(predecessor.leadTurn.intentId)).toEqual(before)
  })

  test('successor safety: completed history cannot bypass host mediation with a fresh or historical key', async () => {
    const f = await fixture()
    const predecessorKey = crypto.randomUUID()
    const predecessor = await f.admit('terminal-target', 3, f.topic.id, {
      idempotencyKey: predecessorKey,
    })
    await observeFixtureRuntime(f, predecessor.leadTurn.intentId, 'completed')
    const before = await retainedHistory(predecessor.leadTurn.intentId)
    await expect(f.bypass('terminal-target', 3)).rejects.toThrow(
      'Lead turn target requires host mediation'
    )
    await expect(
      f.bypass('terminal-target', 3, { idempotencyKey: predecessorKey })
    ).rejects.toThrow('Lead turn target requires host mediation')
    expect(await targetRows(f)).toHaveLength(1)
    expect(await retainedHistory(predecessor.leadTurn.intentId)).toEqual(before)
  })
})
