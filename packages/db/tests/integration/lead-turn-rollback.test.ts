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
import { agents, leadTurnIntents, leadTurnRuntime, messages, workspaces } from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const databaseUrl = process.env.DATABASE_URL

function crockford() {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase()
}

const grant = async () => {}

// Rollback readers and uncertain-effect fencing for lead turns (M18.01.3, #1220).
// Acceptance IDs A01, A02, A30, A31 and A36 refer to the canonical test matrix.
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

  async function dispatched(f: Awaited<ReturnType<typeof fixture>>) {
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
    const fence = await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId)
    expect(fence).toMatchObject({
      intentId: pin.intentId,
      disposition: 'no_effect_recorded',
      fenced: true,
    })
    expect(typeof fence.rollbackFencedAt).toBe('string')
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

    const fence = await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId)
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
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId)
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

  test('A31 a fenced completed attempt keeps exactly one publication and writes no new fence', async () => {
    const f = await fixture()
    const { owner, workspace, pin, binding } = f
    await dispatched(f)
    await observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, {
      ...binding,
      state: 'running',
      observedAt: new Date().toISOString(),
    })
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId)
    await observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, {
      ...binding,
      state: 'completed',
      observedAt: new Date().toISOString(),
    })
    const first = await publishLeadTurnResult(
      connection.db,
      workspace.id,
      pin.intentId,
      owner.principal,
      binding,
      'Answer',
      grant
    )
    const retry = await publishLeadTurnResult(
      connection.db,
      workspace.id,
      pin.intentId,
      owner.principal,
      binding,
      'Answer',
      grant
    )
    expect(retry).toBe(first)
    const published = await connection.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, first))
    expect(published).toHaveLength(1)
    await expect(
      publishLeadTurnResult(
        connection.db,
        workspace.id,
        pin.intentId,
        owner.principal,
        binding,
        'Different',
        grant
      )
    ).rejects.toThrow('RUNTIME_RESPONSE_INVALID')
    expect(
      await readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, owner.principal)
    ).toMatchObject({
      disposition: 'terminal_retained',
      fenced: true,
      runtime: { state: 'completed', publishedMessageId: first },
    })
  })

  test('A31 repeated rollback fencing keeps the first fence time and never writes terminal rows', async () => {
    const f = await fixture()
    const { workspace, pin } = f
    const first = await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId)
    const second = await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId)
    expect(second.rollbackFencedAt).toBe(first.rollbackFencedAt)
    expect(second).toMatchObject({ disposition: 'no_effect_recorded', fenced: true })
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
      fenceLeadTurnForRollback(connection.db, crypto.randomUUID(), pin.intentId)
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
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId)
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
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId)
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

  test('A30 an archived admission keeps its record and fence and fails closed for every reader', async () => {
    const f = await fixture()
    const { owner, workspace, topic, admitted, pin } = f
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId)
    await archiveChannel(connection.db, workspace.id, topic.id, owner.principal, topic.version)
    // Lead-turn authority admits only active channels, so the reader fails closed for the actor
    // too. The record is retained in storage; reading archived history is a separate gap (REQ 045).
    await expect(
      readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, owner.principal)
    ).rejects.toThrow('unavailable')
    const [intent] = await connection.db
      .select({
        id: leadTurnIntents.id,
        messageId: leadTurnIntents.messageId,
        fenced: leadTurnIntents.rollbackFencedAt,
      })
      .from(leadTurnIntents)
      .where(eq(leadTurnIntents.id, pin.intentId))
    expect(intent).toMatchObject({ id: pin.intentId, messageId: admitted.message.id })
    expect(intent?.fenced).toBeInstanceOf(Date)
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await expect(
      readLeadTurnRollbackState(connection.db, workspace.id, pin.intentId, outsider.principal)
    ).rejects.toThrow('unavailable')
  })

  test('A36 the pre-fence projection is unchanged by the fence and the new column stays nullable', async () => {
    const f = await fixture()
    const { workspace, pin } = f
    await dispatched(f)
    const projection = () =>
      connection.db.execute(sql`
        select intent_id, state, dispatch_id, attempt_id, execution_id, published_message_id, publication_digest
        from app.lead_turn_runtime where intent_id = ${pin.intentId}
      `)
    const before = [...(await projection())]
    await fenceLeadTurnForRollback(connection.db, workspace.id, pin.intentId)
    expect([...(await projection())]).toEqual(before)
    const [column] = [
      ...(await connection.db.execute(sql`
        select is_nullable, column_default from information_schema.columns
        where table_schema = 'app' and table_name = 'lead_turn_intents' and column_name = 'rollback_fenced_at'
      `)),
    ]
    expect(column).toEqual({ is_nullable: 'YES', column_default: null })
    const [row] = await connection.db
      .select({ state: leadTurnRuntime.state })
      .from(leadTurnRuntime)
      .where(eq(leadTurnRuntime.intentId, pin.intentId))
    expect(row?.state).toBe('dispatch_pending')
  })
})
