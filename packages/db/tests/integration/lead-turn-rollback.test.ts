import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { createAgent, ensureWorkspaceLead, listAgentsForUser } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { archiveChannel, createDirectAgentTopic } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { createLeadTurn } from '../../src/lead-turns'
import {
  authorizeLeadTurnFundingBinding,
  markLeadTurnDispatchPending,
  observeLeadTurnRuntime,
  prepareLeadTurnRuntime,
  publishLeadTurnResult,
  readLeadTurnRuntime,
  recoverLeadTurnRuntimeBinding,
  requestLeadTurnCancellation,
} from '../../src/lead-turn-runtime'
import { fenceLeadTurnForRollback, readLeadTurnRollbackState } from '../../src/lead-turn-rollback'
import {
  agents,
  channelParticipants,
  leadTurnIntents,
  leadTurnRuntime,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

/** Returns the constraint name a rejected write violated, so tests can assert the exact rule. */
async function violatedConstraint(write: Promise<unknown>) {
  try {
    await write
  } catch (error) {
    const cause = (error as { cause?: { constraint_name?: string } }).cause
    return cause?.constraint_name ?? (error as Error).message
  }
  throw new Error('expected the write to be rejected')
}

const databaseUrl = process.env.DATABASE_URL

function crockford() {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase()
}

// Rollback readers and uncertain-effect fencing for lead turns (M18.01.3, #1220).
// Acceptance IDs A01, A02, A30, A31 and A36 refer to the canonical test matrix. REQ 045 governs
// archived history, and REQ 154 governs fence attribution.
describe.skipIf(!databaseUrl)('lead-turn rollback fence and readers', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(databaseUrl!)
  })
  afterAll(() => connection.close())

  async function fixture() {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      name: 'Rollback fence fixture',
      owner: owner.principal,
      idempotencyKey: crypto.randomUUID(),
    })
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    const topicKey = crypto.randomUUID()
    const topic = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      { title: 'Rollback', idempotencyKey: topicKey }
    )
    const turnKey = crypto.randomUUID()
    const admitted = await createLeadTurn(connection.db, workspace.id, topic.id, owner.principal, {
      bodyText: 'Canonical question',
      idempotencyKey: turnKey,
    })
    const execution = crockford()
    const [canonicalWorkspace] = await connection.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id))
    const pin = {
      workspaceId: canonicalWorkspace!.controlPlaneWorkspaceId,
      intentId: admitted.leadTurn.intentId,
      executionId: `exe_${execution}`,
      attemptId: `att_${execution}`,
      selectionRef: `msel_${crypto.randomUUID().replaceAll('-', '')}`,
      selectionRevision: 1,
      preparationRef: `prep_${crypto.randomUUID().replaceAll('-', '')}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }
    const binding = {
      intentId: pin.intentId,
      executionId: pin.executionId,
      attemptId: pin.attemptId,
      dispatchId: `dispatch_${crypto.randomUUID().replaceAll('-', '')}`,
      runtimeSessionId: `ses_${crockford()}`,
    }
    return { owner, workspace, lead, topic, topicKey, admitted, turnKey, pin, binding }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>

  /** The owner is a workspace owner, so the fence is authorized through the live membership. */
  function ownerFence(f: Fixture) {
    return {
      actor: { kind: 'user' as const, principal: f.owner.principal },
      reason: 'rollback_cohort' as const,
    }
  }

  async function dispatched(f: Fixture) {
    const { owner, workspace, pin } = f
    await prepareLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, pin)
    await markLeadTurnDispatchPending(
      connection.db,
      workspace.id,
      pin.intentId,
      owner.principal,
      pin
    )
  }

  async function addParticipantMember(f: Fixture, role: 'member' | 'admin' = 'member') {
    const member = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await connection.db.insert(workspaceMemberships).values({
      workspaceId: f.workspace.id,
      userId: member.principal.userId,
      role,
    })
    await connection.db.insert(channelParticipants).values({
      workspaceId: f.workspace.id,
      channelId: f.topic.id,
      principalKind: 'user',
      userId: member.principal.userId,
    })
    return member
  }

  test('A31 fencing a prepared admission blocks new dispatch and keeps the prepared record intact', async () => {
    const f = await fixture()
    const { owner, workspace, pin } = f
    await prepareLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, pin)
    const before = await readLeadTurnRollbackState(
      connection.db,
      workspace.id,
      pin.intentId,
      owner.principal
    )
    expect(before).toMatchObject({
      disposition: 'fence_required',
      fenced: false,
      runtime: { state: 'prepared' },
    })
    const fence = await fenceLeadTurnForRollback(
      connection.db,
      workspace.id,
      pin.intentId,
      ownerFence(f)
    )
    expect(fence).toMatchObject({
      intentId: pin.intentId,
      disposition: 'no_effect_recorded',
      fenced: true,
      alreadyFenced: false,
    })
    expect(fence.attribution?.fencedAt).toEqual(expect.any(String))
    await expect(
      markLeadTurnDispatchPending(connection.db, workspace.id, pin.intentId, owner.principal, pin)
    ).rejects.toThrow('LEAD_TURN_FENCED')
    await expect(
      prepareLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, pin)
    ).rejects.toThrow('LEAD_TURN_FENCED')
    expect(
      await authorizeLeadTurnFundingBinding(connection.db, workspace.id, owner.principal, pin)
    ).toBe(false)
    expect(
      await readLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal)
    ).toMatchObject({ state: 'prepared', selectionRef: pin.selectionRef })
  })

  test('A31 uncertain dispatch keeps its evidence, reconciles by binding and is never redispatched', async () => {
    const f = await fixture()
    const { owner, workspace, pin, binding } = f
    await dispatched(f)
    const evidence = await readLeadTurnRuntime(
      connection.db,
      workspace.id,
      pin.intentId,
      owner.principal
    )
    expect(evidence).toMatchObject({ state: 'dispatch_pending' })
    expect(evidence).not.toHaveProperty('dispatchId')

    const fence = await fenceLeadTurnForRollback(
      connection.db,
      workspace.id,
      pin.intentId,
      ownerFence(f)
    )
    expect(fence).toMatchObject({ disposition: 'reconcile_uncertain_effect', fenced: true })
    expect(
      await readLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal)
    ).toEqual(evidence!)

    await recoverLeadTurnRuntimeBinding(
      connection.db,
      workspace.id,
      pin.intentId,
      owner.principal,
      binding
    )
    expect(
      await readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, owner.principal)
    ).toMatchObject({
      disposition: 'reconcile_uncertain_effect',
      fenced: true,
      runtime: { state: 'dispatch_pending', dispatchId: binding.dispatchId },
    })

    await observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, {
      ...binding,
      state: 'running',
      observedAt: new Date().toISOString(),
    })
    expect(
      await readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, owner.principal)
    ).toMatchObject({ disposition: 'in_flight_fenced', fenced: true })
    await expect(
      markLeadTurnDispatchPending(connection.db, workspace.id, pin.intentId, owner.principal, pin)
    ).rejects.toThrow('LEAD_TURN_FENCED')
  })

  test('A31 a fenced in-flight attempt may be cancelled and observed, and ends as retained history', async () => {
    const f = await fixture()
    const { owner, workspace, pin, binding } = f
    await dispatched(f)
    await observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, {
      ...binding,
      state: 'running',
      observedAt: new Date().toISOString(),
    })
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, ownerFence(f))
    await requestLeadTurnCancellation(connection.db, workspace.id, pin.intentId, owner.principal)
    expect(
      await readLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal)
    ).toHaveProperty('cancelRequestedAt')
    await observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, {
      ...binding,
      state: 'cancelled',
      observedAt: new Date().toISOString(),
    })
    expect(
      await readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, owner.principal)
    ).toMatchObject({
      disposition: 'terminal_retained',
      fenced: true,
      runtime: { state: 'cancelled' },
    })
  })

  test('A31 a fence set while the attempt is in flight denies publication of its completed result, and writes no message', async () => {
    const f = await fixture()
    const { owner, workspace, pin, binding } = f
    await dispatched(f)
    await observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, {
      ...binding,
      state: 'running',
      observedAt: new Date().toISOString(),
    })
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, ownerFence(f))
    await observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, {
      ...binding,
      state: 'completed',
      observedAt: new Date().toISOString(),
    })
    let granted = 0
    await expect(
      publishLeadTurnResult(
        connection.db,
        workspace.id,
        pin.intentId,
        owner.principal,
        binding,
        'Answer',
        async () => {
          granted++
        }
      )
    ).rejects.toThrow('LEAD_TURN_FENCED')
    expect(granted).toBe(0)
    expect(
      await readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, owner.principal)
    ).toMatchObject({
      disposition: 'terminal_retained',
      fenced: true,
      runtime: { state: 'completed' },
    })
    expect(
      await readLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal)
    ).not.toHaveProperty('publishedMessageId')
  })

  test('A31 an outsider or a foreign workspace learns nothing from the reader or the fence', async () => {
    const f = await fixture()
    const { owner, workspace, pin } = f
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await expect(
      readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, outsider.principal)
    ).rejects.toThrow('unavailable')
    await expect(
      fenceLeadTurnForRollback(connection.db, crypto.randomUUID(), pin.intentId, ownerFence(f))
    ).rejects.toThrow('unavailable')
    expect(
      await readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, owner.principal)
    ).toMatchObject({ fenced: false, disposition: 'fence_required' })
  })

  test('A01 rollback reads and fencing keep exactly one workspace lead and every custom Agent', async () => {
    const f = await fixture()
    const { owner, workspace, lead, pin } = f
    const custom = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Custom',
      profileId: 'custom-profile',
      profileVersion: '1',
    })
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, ownerFence(f))
    await readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, owner.principal)
    const leads = await connection.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspace.id), eq(agents.isWorkspaceLead, true)))
    expect(leads.map((row) => row.id)).toEqual([lead.id])
    expect((await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)).id).toBe(
      lead.id
    )
    const listed = await listAgentsForUser(connection.db, workspace.id, owner.principal)
    expect(listed.map((agent) => agent.id)).toEqual(expect.arrayContaining([lead.id, custom.id]))
  })

  test('A02 a retried admission after the fence returns the original intent and topics with one Agent stay distinct', async () => {
    const f = await fixture()
    const { owner, workspace, lead, topic, topicKey, admitted, turnKey, pin } = f
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, ownerFence(f))
    const retry = await createLeadTurn(connection.db, workspace.id, topic.id, owner.principal, {
      bodyText: 'Canonical question',
      idempotencyKey: turnKey,
    })
    expect(retry.message.id).toBe(admitted.message.id)
    expect(retry.leadTurn.intentId).toBe(admitted.leadTurn.intentId)
    const sameTopic = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      { title: 'Rollback', idempotencyKey: topicKey }
    )
    expect(sameTopic.id).toBe(topic.id)
    const otherTopic = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      { title: 'Second', idempotencyKey: crypto.randomUUID() }
    )
    expect(otherTopic.id).not.toBe(topic.id)
  })

  test('A30 archived history stays observable to a current participant with its fence attribution', async () => {
    const f = await fixture()
    const { owner, workspace, topic, admitted, pin } = f
    await prepareLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, pin)
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, ownerFence(f))
    await archiveChannel(connection.db, workspace.id, topic.id, owner.principal, topic.version)
    expect(
      await readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, owner.principal)
    ).toMatchObject({
      intentId: pin.intentId,
      messageId: admitted.message.id,
      channelLifecycleState: 'archived',
      disposition: 'no_effect_recorded',
      fenced: true,
      runtime: { state: 'prepared', executionId: pin.executionId },
      attribution: {
        actor: { kind: 'user', userId: owner.principal.userId },
        reason: 'rollback_cohort',
        authority: { actorRole: 'owner', channelLifecycleState: 'active' },
      },
    })
  })

  test('A30 a removed participant, a removed membership and an outsider are denied archived history', async () => {
    const f = await fixture()
    const { owner, workspace, topic, pin } = f
    const member = await addParticipantMember(f)
    await archiveChannel(connection.db, workspace.id, topic.id, owner.principal, topic.version)
    await expect(
      readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, member.principal)
    ).resolves.toMatchObject({ channelLifecycleState: 'archived' })

    await connection.db
      .delete(channelParticipants)
      .where(
        and(
          eq(channelParticipants.channelId, topic.id),
          eq(channelParticipants.userId, member.principal.userId)
        )
      )
    await expect(
      readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, member.principal)
    ).rejects.toThrow('unavailable')

    await connection.db.insert(channelParticipants).values({
      workspaceId: workspace.id,
      channelId: topic.id,
      principalKind: 'user',
      userId: member.principal.userId,
    })
    await connection.db
      .delete(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspace.id),
          eq(workspaceMemberships.userId, member.principal.userId)
        )
      )
    await expect(
      readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, member.principal)
    ).rejects.toThrow('unavailable')

    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await expect(
      readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, outsider.principal)
    ).rejects.toThrow('unavailable')
  })

  test('A30 archival denies every new effect while retained history stays readable', async () => {
    const prepared = await fixture()
    const { owner, workspace, topic, pin } = prepared
    await prepareLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, pin)
    await archiveChannel(connection.db, workspace.id, topic.id, owner.principal, topic.version)
    await expect(
      markLeadTurnDispatchPending(connection.db, workspace.id, pin.intentId, owner.principal, pin)
    ).rejects.toThrow('unavailable')
    await expect(
      prepareLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, pin)
    ).rejects.toThrow('unavailable')
    expect(
      await authorizeLeadTurnFundingBinding(connection.db, workspace.id, owner.principal, pin)
    ).toBe(false)
    await expect(
      createLeadTurn(connection.db, workspace.id, topic.id, owner.principal, {
        bodyText: 'After archive',
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow('unavailable')
    expect(
      await readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, owner.principal)
    ).toMatchObject({ channelLifecycleState: 'archived', runtime: { state: 'prepared' } })
  })

  test('A36 the pre-fence projection is unchanged by the fence and every new column stays nullable', async () => {
    const f = await fixture()
    const { workspace, pin } = f
    await dispatched(f)
    const projection = () =>
      connection.db.execute(sql`
        select intent_id, state, dispatch_id, attempt_id, execution_id, published_message_id, publication_digest
        from app.lead_turn_runtime where intent_id = ${pin.intentId}
      `)
    const before = [...(await projection())]
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, ownerFence(f))
    expect([...(await projection())]).toEqual(before)
    const columns = [
      ...(await connection.db.execute(sql`
        select column_name, is_nullable, column_default from information_schema.columns
        where table_schema = 'app' and table_name = 'lead_turn_intents' and column_name like 'rollback_fence%'
        order by column_name
      `)),
    ]
    expect(columns.map((column) => column.column_name)).toEqual([
      'rollback_fence_actor_kind',
      'rollback_fence_actor_ref',
      'rollback_fence_authority',
      'rollback_fence_reason',
      'rollback_fenced_at',
    ])
    expect(columns.every((c) => c.is_nullable === 'YES' && c.column_default === null)).toBe(true)
    const [row] = await connection.db
      .select({ state: leadTurnRuntime.state })
      .from(leadTurnRuntime)
      .where(eq(leadTurnRuntime.intentId, pin.intentId))
    expect(row?.state).toBe('dispatch_pending')
  })

  test('A31 REQ 154 fence attribution is written with the fence and the first attribution is kept', async () => {
    const f = await fixture()
    const { owner, workspace, topic, pin } = f
    const first = await fenceLeadTurnForRollback(
      connection.db,
      workspace.id,
      pin.intentId,
      ownerFence(f)
    )
    expect(first).toMatchObject({ alreadyFenced: false, fenced: true })
    expect(first.attribution).toEqual({
      fencedAt: expect.any(String),
      actor: { kind: 'user', userId: owner.principal.userId },
      reason: 'rollback_cohort',
      authority: {
        schemaVersion: 1,
        workspaceId: workspace.id,
        actorMembershipId: expect.any(String),
        actorRole: 'owner',
        channelId: topic.id,
        channelVersion: topic.version,
        channelLifecycleState: 'active',
        runtimeState: null,
        disposition: 'no_effect_recorded',
      },
    })
    const second = await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, {
      actor: { kind: 'operator', operatorId: 'ops:rollback-1' },
      reason: 'operator_intervention',
    })
    expect(second).toMatchObject({ alreadyFenced: true, fenced: true })
    expect(second.attribution).toEqual(first.attribution)
    const [row] = await connection.db
      .select({
        actorKind: leadTurnIntents.rollbackFenceActorKind,
        actorRef: leadTurnIntents.rollbackFenceActorRef,
        reason: leadTurnIntents.rollbackFenceReason,
        fencedAt: leadTurnIntents.rollbackFencedAt,
      })
      .from(leadTurnIntents)
      .where(eq(leadTurnIntents.id, pin.intentId))
    expect(row).toEqual({
      actorKind: 'user',
      actorRef: owner.principal.userId,
      reason: 'rollback_cohort',
      fencedAt: new Date(first.attribution!.fencedAt),
    })
  })

  test('A31 REQ 154 a plain member cannot fence and an outsider learns nothing', async () => {
    const f = await fixture()
    const { workspace, pin } = f
    const member = await addParticipantMember(f, 'member')
    await expect(
      fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, {
        actor: { kind: 'user', principal: member.principal },
        reason: 'rollback_cohort',
      })
    ).rejects.toThrow('ROLLBACK_FENCE_FORBIDDEN')
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await expect(
      fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, {
        actor: { kind: 'user', principal: outsider.principal },
        reason: 'rollback_cohort',
      })
    ).rejects.toThrow('unavailable')
    const [row] = await connection.db
      .select({ fencedAt: leadTurnIntents.rollbackFencedAt })
      .from(leadTurnIntents)
      .where(eq(leadTurnIntents.id, pin.intentId))
    expect(row?.fencedAt).toBeNull()
  })

  test('A31 REQ 154 an operator fence needs a well-formed id and writes nothing when it is refused', async () => {
    const f = await fixture()
    const { workspace, pin } = f
    await expect(
      fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, {
        actor: { kind: 'operator', operatorId: 'Bad Operator Id' },
        reason: 'operator_intervention',
      })
    ).rejects.toThrow('INVALID_ROLLBACK_FENCE_REQUEST')
    const fence = await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, {
      actor: { kind: 'operator', operatorId: 'ops:rollback-1' },
      reason: 'operator_intervention',
    })
    expect(fence.attribution).toMatchObject({
      actor: { kind: 'operator', operatorId: 'ops:rollback-1' },
      reason: 'operator_intervention',
      authority: { actorRole: null, actorMembershipId: null },
    })
  })

  test('A31 REQ 154 the database rejects partial or malformed fence attribution', async () => {
    const f = await fixture()
    const { pin } = f
    expect(
      await violatedConstraint(
        connection.db.execute(sql`
          update app.lead_turn_intents set rollback_fenced_at = now() where id = ${pin.intentId}
        `)
      )
    ).toBe('lead_turn_intents_rollback_fence_complete')
    expect(
      await violatedConstraint(
        connection.db.execute(sql`
          update app.lead_turn_intents set rollback_fenced_at = now(), rollback_fence_actor_kind = 'user',
            rollback_fence_actor_ref = 'not-a-uuid', rollback_fence_reason = 'rollback_cohort',
            rollback_fence_authority = '{"schemaVersion": 1}' where id = ${pin.intentId}
        `)
      )
    ).toBe('lead_turn_intents_rollback_fence_actor_valid')
    expect(
      await violatedConstraint(
        connection.db.execute(sql`
          update app.lead_turn_intents set rollback_fenced_at = now(), rollback_fence_actor_kind = 'operator',
            rollback_fence_actor_ref = 'ops:x', rollback_fence_reason = 'retry_forever',
            rollback_fence_authority = '{"schemaVersion": 1}' where id = ${pin.intentId}
        `)
      )
    ).toBe('lead_turn_intents_rollback_fence_reason_valid')
    expect(
      await violatedConstraint(
        connection.db.execute(sql`
          update app.lead_turn_intents set rollback_fenced_at = now(), rollback_fence_actor_kind = 'operator',
            rollback_fence_actor_ref = 'ops:x', rollback_fence_reason = 'operator_intervention',
            rollback_fence_authority = '{"workspaceId": "x"}' where id = ${pin.intentId}
        `)
      )
    ).toBe('lead_turn_intents_rollback_fence_authority_valid')
    const [row] = await connection.db
      .select({ fencedAt: leadTurnIntents.rollbackFencedAt })
      .from(leadTurnIntents)
      .where(eq(leadTurnIntents.id, pin.intentId))
    expect(row?.fencedAt).toBeNull()
  })

  test('A31 REQ 154 recorded fence attribution cannot be rewritten or cleared, and unrelated updates still pass', async () => {
    const f = await fixture()
    const { owner, workspace, pin } = f
    const fence = await fenceLeadTurnForRollback(
      connection.db,
      workspace.id,
      pin.intentId,
      ownerFence(f)
    )
    expect(
      await violatedConstraint(
        connection.db.execute(sql`
          update app.lead_turn_intents set rollback_fenced_at = now() + interval '1 day'
          where id = ${pin.intentId}
        `)
      )
    ).toBe('lead_turn_intents_rollback_fence_immutable')
    expect(
      await violatedConstraint(
        connection.db.execute(sql`
          update app.lead_turn_intents set rollback_fence_actor_kind = 'operator',
            rollback_fence_actor_ref = 'ops:takeover' where id = ${pin.intentId}
        `)
      )
    ).toBe('lead_turn_intents_rollback_fence_immutable')
    expect(
      await violatedConstraint(
        connection.db.execute(sql`
          update app.lead_turn_intents set rollback_fenced_at = null, rollback_fence_actor_kind = null,
            rollback_fence_actor_ref = null, rollback_fence_reason = null,
            rollback_fence_authority = null where id = ${pin.intentId}
        `)
      )
    ).toBe('lead_turn_intents_rollback_fence_immutable')
    await connection.db.execute(sql`
      update app.lead_turn_intents set updated_at = now() where id = ${pin.intentId}
    `)
    expect(
      await readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, owner.principal)
    ).toMatchObject({ fenced: true, attribution: fence.attribution })
  })
})
