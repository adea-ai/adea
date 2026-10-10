import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { ensureWorkspaceLead } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { archiveChannel, createDirectAgentTopic } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import {
  createLeadTurn,
  getLatestLeadTurnForChannel,
  getLeadTurnForUser,
} from '../../src/lead-turns'
import { readCurrentLeadTurnProduct } from '../../src/lead-turn-product'
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
import { channelParticipants, messages, workspaceMemberships, workspaces } from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const databaseUrl = process.env.DATABASE_URL

const grant = async () => {}

/** Asserts a denied call and that it fails with the single unavailable answer, not which path fired. */
async function denied(call: Promise<unknown>) {
  await expect(call).rejects.toThrow('unavailable')
}

function crockford() {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase()
}

// Historical reads and reconciliation through the canonical lead-turn APIs (REQ 045, REQ 154).
// Archived admissions stay observable and reconcilable for current participants. No API admits a
// new effect on them, and the signed product reader emits fence facts only for active admissions.
describe.skipIf(!databaseUrl)('lead-turn historical reads and reconciliation', () => {
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
      name: 'Historical reads fixture',
      owner: owner.principal,
      idempotencyKey: crypto.randomUUID(),
    })
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    const topic = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      { title: 'Historical', idempotencyKey: crypto.randomUUID() }
    )
    const admitted = await createLeadTurn(connection.db, workspace.id, topic.id, owner.principal, {
      bodyText: 'Canonical question',
      idempotencyKey: crypto.randomUUID(),
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
    return { owner, workspace, lead, topic, admitted, pin, binding }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>

  /** A current workspace member who is also a channel participant. Added before any archival. */
  async function addParticipant(f: Fixture) {
    const member = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await connection.db.insert(workspaceMemberships).values({
      workspaceId: f.workspace.id,
      userId: member.principal.userId,
      role: 'member',
    })
    await connection.db.insert(channelParticipants).values({
      workspaceId: f.workspace.id,
      channelId: f.topic.id,
      principalKind: 'user',
      userId: member.principal.userId,
    })
    return member
  }

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

  async function archive(f: Fixture) {
    await archiveChannel(
      connection.db,
      f.workspace.id,
      f.topic.id,
      f.owner.principal,
      f.topic.version
    )
  }

  test('A30 an archived uncertain dispatch is readable through every canonical read API by a current participant', async () => {
    const f = await fixture()
    const { owner, workspace, topic, admitted, pin } = f
    await dispatched(f)
    const member = await addParticipant(f)
    const fence = await fenceLeadTurnForRollback(
      connection.db,
      workspace.id,
      pin.intentId,
      ownerFence(f)
    )
    await archive(f)
    expect(
      await getLeadTurnForUser(connection.db, workspace.id, admitted.message.id, member.principal)
    ).toMatchObject({
      intentId: pin.intentId,
      messageId: admitted.message.id,
    })
    expect(
      await getLatestLeadTurnForChannel(connection.db, workspace.id, topic.id, member.principal)
    ).toMatchObject({ intentId: pin.intentId })
    expect(
      await readLeadTurnRuntime(connection.db, workspace.id, pin.intentId, member.principal)
    ).toMatchObject({
      state: 'dispatch_pending',
    })
    const rollback = await readLeadTurnRollbackState(
      connection.db,
      workspace.id,
      pin.intentId,
      member.principal
    )
    expect(rollback).toMatchObject({
      disposition: 'reconcile_uncertain_effect',
      channelLifecycleState: 'archived',
      fenced: true,
    })
    expect(rollback.attribution).toEqual(fence.attribution)
    expect(rollback.attribution?.actor).toEqual({ kind: 'user', userId: owner.principal.userId })
  })

  test('A31 a current participant reconciles an archived uncertain dispatch by binding and observation, and never by redispatch', async () => {
    const f = await fixture()
    const { owner, workspace, pin, binding } = f
    await dispatched(f)
    const member = await addParticipant(f)
    const fence = await fenceLeadTurnForRollback(
      connection.db,
      workspace.id,
      pin.intentId,
      ownerFence(f)
    )
    await archive(f)

    const recovered = await recoverLeadTurnRuntimeBinding(
      connection.db,
      workspace.id,
      pin.intentId,
      member.principal,
      binding
    )
    expect(recovered).toMatchObject({ state: 'dispatch_pending', dispatchId: binding.dispatchId })

    const running = await observeLeadTurnRuntime(
      connection.db,
      workspace.id,
      pin.intentId,
      member.principal,
      {
        ...binding,
        state: 'running',
        observedAt: new Date().toISOString(),
      }
    )
    expect(running).toMatchObject({ state: 'running' })
    const inFlight = await readLeadTurnRollbackState(
      connection.db,
      workspace.id,
      pin.intentId,
      member.principal
    )
    expect(inFlight).toMatchObject({
      disposition: 'in_flight_fenced',
      channelLifecycleState: 'archived',
    })

    await observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, member.principal, {
      ...binding,
      state: 'completed',
      observedAt: new Date().toISOString(),
    })
    const terminal = await readLeadTurnRollbackState(
      connection.db,
      workspace.id,
      pin.intentId,
      member.principal
    )
    expect(terminal).toMatchObject({
      disposition: 'terminal_retained',
      runtime: { state: 'completed' },
    })

    // Reconciliation never changes the immutable attribution.
    expect(terminal.attribution).toEqual(fence.attribution)
    // No redispatch: the admission cannot be re-prepared or re-dispatched, archived or not.
    await denied(
      markLeadTurnDispatchPending(connection.db, workspace.id, pin.intentId, owner.principal, pin)
    )
    await denied(
      prepareLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, pin)
    )
  })

  test('A31 the original actor cancels an archived in-flight attempt, and the cancellation is recorded without redispatch', async () => {
    const f = await fixture()
    const { owner, workspace, pin, binding } = f
    await dispatched(f)
    await observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, {
      ...binding,
      state: 'running',
      observedAt: new Date().toISOString(),
    })
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, ownerFence(f))
    await archive(f)
    await requestLeadTurnCancellation(connection.db, workspace.id, pin.intentId, owner.principal)
    const cancelling = await readLeadTurnRuntime(
      connection.db,
      workspace.id,
      pin.intentId,
      owner.principal
    )
    expect(cancelling).toHaveProperty('cancelRequestedAt')
    await observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, {
      ...binding,
      state: 'cancelled',
      observedAt: new Date().toISOString(),
    })
    expect(
      await readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, owner.principal)
    ).toMatchObject({ disposition: 'terminal_retained', runtime: { state: 'cancelled' } })
  })

  test('A30 archival denies every new effect for a fenced prepared admission and leaves the record unchanged', async () => {
    const f = await fixture()
    const { owner, workspace, topic, pin } = f
    await prepareLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, pin)
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, ownerFence(f))
    await archive(f)
    const before = await readLeadTurnRuntime(
      connection.db,
      workspace.id,
      pin.intentId,
      owner.principal
    )
    await denied(
      markLeadTurnDispatchPending(connection.db, workspace.id, pin.intentId, owner.principal, pin)
    )
    await denied(
      prepareLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, pin)
    )
    await denied(
      createLeadTurn(connection.db, workspace.id, topic.id, owner.principal, {
        bodyText: 'After archive',
        idempotencyKey: crypto.randomUUID(),
      })
    )
    expect(
      await authorizeLeadTurnFundingBinding(connection.db, workspace.id, owner.principal, pin)
    ).toBe(false)
    expect(
      await readLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal)
    ).toEqual(before!)
  })

  test('A30 a participant who is not the original actor cannot cancel archived history', async () => {
    const f = await fixture()
    const { owner, workspace, pin, binding } = f
    await dispatched(f)
    await observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, {
      ...binding,
      state: 'running',
      observedAt: new Date().toISOString(),
    })
    const member = await addParticipant(f)
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, ownerFence(f))
    await archive(f)
    await denied(
      requestLeadTurnCancellation(connection.db, workspace.id, pin.intentId, member.principal)
    )
    expect(
      await readLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal)
    ).not.toHaveProperty('cancelRequestedAt')
  })

  test('A30 a removed participant or a removed membership loses observation, recovery and cancellation of archived history', async () => {
    const f = await fixture()
    const { workspace, topic, pin, binding } = f
    await dispatched(f)
    const member = await addParticipant(f)
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, ownerFence(f))
    await archive(f)

    await connection.db
      .delete(channelParticipants)
      .where(
        and(
          eq(channelParticipants.channelId, topic.id),
          eq(channelParticipants.userId, member.principal.userId)
        )
      )
    await denied(readLeadTurnRuntime(connection.db, workspace.id, pin.intentId, member.principal))
    await denied(
      recoverLeadTurnRuntimeBinding(
        connection.db,
        workspace.id,
        pin.intentId,
        member.principal,
        binding
      )
    )
    await denied(
      observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, member.principal, {
        ...binding,
        state: 'running',
        observedAt: new Date().toISOString(),
      })
    )

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
    await denied(readLeadTurnRuntime(connection.db, workspace.id, pin.intentId, member.principal))
    await denied(
      observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, member.principal, {
        ...binding,
        state: 'running',
        observedAt: new Date().toISOString(),
      })
    )
  })

  test('A31 an outsider and a foreign workspace get the same unavailable answer on every historical API', async () => {
    const f = await fixture()
    const { workspace, topic, pin, binding } = f
    await dispatched(f)
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, ownerFence(f))
    await archive(f)
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await denied(
      getLeadTurnForUser(connection.db, workspace.id, f.admitted.message.id, outsider.principal)
    )
    await denied(
      getLatestLeadTurnForChannel(connection.db, workspace.id, topic.id, outsider.principal)
    )
    await denied(readLeadTurnRuntime(connection.db, workspace.id, pin.intentId, outsider.principal))
    await denied(
      readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, outsider.principal)
    )
    await denied(
      observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, outsider.principal, {
        ...binding,
        state: 'running',
        observedAt: new Date().toISOString(),
      })
    )
    await denied(
      requestLeadTurnCancellation(connection.db, workspace.id, pin.intentId, outsider.principal)
    )
    await denied(
      readLeadTurnRuntime(connection.db, crypto.randomUUID(), pin.intentId, f.owner.principal)
    )
  })

  test('A31 a forged observation on archived history is refused as a response-shape violation', async () => {
    const f = await fixture()
    const { owner, workspace, pin, binding } = f
    await dispatched(f)
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, ownerFence(f))
    await archive(f)
    await expect(
      observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, {
        ...binding,
        executionId: `exe_${crockford()}`,
        state: 'running',
        observedAt: new Date().toISOString(),
      })
    ).rejects.toThrow('RUNTIME_RESPONSE_INVALID')
  })

  test('A30 archived history never publishes a new message, even for a completed result', async () => {
    const f = await fixture()
    const { owner, workspace, pin, binding } = f
    await dispatched(f)
    await observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, {
      ...binding,
      state: 'running',
      observedAt: new Date().toISOString(),
    })
    await observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, {
      ...binding,
      state: 'completed',
      observedAt: new Date().toISOString(),
    })
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, ownerFence(f))
    await archive(f)
    const messageCount = async () =>
      (
        await connection.db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.channelId, f.topic.id))
      ).length
    const before = await messageCount()
    await denied(
      publishLeadTurnResult(
        connection.db,
        workspace.id,
        pin.intentId,
        owner.principal,
        binding,
        'Answer',
        grant
      )
    )
    expect(await messageCount()).toBe(before)
    expect(
      await readLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal)
    ).not.toHaveProperty('publishedMessageId')
  })

  test('A31 the signed product reader emits the fence facts of an active fenced admission and forbids dispatch', async () => {
    const f = await fixture()
    const { owner, workspace, pin } = f
    const fence = await fenceLeadTurnForRollback(
      connection.db,
      workspace.id,
      pin.intentId,
      ownerFence(f)
    )
    const product = await readCurrentLeadTurnProduct(connection.db, pin.workspaceId, pin.intentId)
    expect(product).toMatchObject({
      intentId: pin.intentId,
      dispatchPermitted: false,
      rollbackFence: {
        fencedAt: fence.attribution?.fencedAt,
        reason: 'rollback_cohort',
        actor: { kind: 'user', userId: owner.principal.userId },
      },
    })
  })

  test('A31 an operator fence is emitted by reference, and an unfenced active admission permits dispatch', async () => {
    const f = await fixture()
    const { workspace, pin } = f
    const unfenced = await readCurrentLeadTurnProduct(connection.db, pin.workspaceId, pin.intentId)
    expect(unfenced).toMatchObject({ dispatchPermitted: true, rollbackFence: null })
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, {
      actor: { kind: 'operator', operatorId: 'ops:rollback-1' },
      reason: 'operator_intervention',
    })
    expect(
      await readCurrentLeadTurnProduct(connection.db, pin.workspaceId, pin.intentId)
    ).toMatchObject({
      dispatchPermitted: false,
      rollbackFence: {
        reason: 'operator_intervention',
        actor: { kind: 'operator', operatorId: 'ops:rollback-1' },
      },
    })
  })

  test('A30 the signed product reader never emits an archived admission, fenced or not', async () => {
    const f = await fixture()
    const { workspace, pin } = f
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId, ownerFence(f))
    await archive(f)
    await denied(readCurrentLeadTurnProduct(connection.db, pin.workspaceId, pin.intentId))
    // Historical reads still work for the actor, so only the dispatch seam is closed.
    expect(
      await readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, f.owner.principal)
    ).toMatchObject({ channelLifecycleState: 'archived' })
  })
})
