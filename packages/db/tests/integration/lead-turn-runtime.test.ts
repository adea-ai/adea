import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ensureWorkspaceLead } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createDirectAgentTopic } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { createLeadTurn, getLatestLeadTurnForChannel } from '../../src/lead-turns'
import {
  prepareLeadTurnRuntime,
  markLeadTurnDispatchPending,
  observeLeadTurnRuntime,
  publishLeadTurnResult,
  requestLeadTurnCancellation,
  readLeadTurnRuntime,
  recoverLeadTurnRuntimeBinding,
} from '../../src/lead-turn-runtime'
import {
  leadTurnRuntime,
  messages,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('trusted lead runtime observation/publication', () => {
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
      name: 'Runtime publication fixture',
      owner: owner.principal,
      idempotencyKey: crypto.randomUUID(),
    })
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    const topic = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      { title: 'Publication', idempotencyKey: crypto.randomUUID() }
    )
    const admitted = await createLeadTurn(connection.db, workspace.id, topic.id, owner.principal, {
      bodyText: 'Canonical question',
      idempotencyKey: crypto.randomUUID(),
    })
    const execution = crypto
      .randomUUID()
      .replaceAll('-', '')
      .slice(0, 26)
      .toUpperCase()
      .replace(/[ILOU]/g, '0')
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
      runtimeSessionId: `ses_${execution}`,
    }
    return { owner, workspace, lead, topic, admitted, pin, binding }
  }
  test('prepare persists no runtime session; retry cannot swap the accepted selection or attempt', async () => {
    const f = await fixture()
    await prepareLeadTurnRuntime(
      connection.db,
      f.workspace.id,
      f.pin.intentId,
      f.owner.principal,
      f.pin
    )
    expect(
      await getLatestLeadTurnForChannel(
        connection.db,
        f.workspace.id,
        f.topic.id,
        f.owner.principal
      )
    ).toMatchObject({ intentId: f.pin.intentId, messageId: f.admitted.message.id })
    expect(
      await readLeadTurnRuntime(connection.db, f.workspace.id, f.pin.intentId, f.owner.principal)
    ).toMatchObject({ state: 'prepared', selectionRef: f.pin.selectionRef })
    expect(
      await readLeadTurnRuntime(connection.db, f.workspace.id, f.pin.intentId, f.owner.principal)
    ).not.toHaveProperty('runtimeSessionId')
    await expect(
      prepareLeadTurnRuntime(connection.db, f.workspace.id, f.pin.intentId, f.owner.principal, {
        ...f.pin,
        selectionRevision: 2,
      })
    ).rejects.toThrow('RUNTIME_RESPONSE_INVALID')
  })
  test('unavailable publication grant withholds content and retry publishes exactly one canonical message/event', async () => {
    const f = await fixture()
    await prepareLeadTurnRuntime(
      connection.db,
      f.workspace.id,
      f.pin.intentId,
      f.owner.principal,
      f.pin
    )
    await markLeadTurnDispatchPending(
      connection.db,
      f.workspace.id,
      f.pin.intentId,
      f.owner.principal,
      f.pin
    )
    await observeLeadTurnRuntime(connection.db, f.workspace.id, f.pin.intentId, f.owner.principal, {
      ...f.binding,
      state: 'completed',
      observedAt: new Date().toISOString(),
    })
    await expect(
      publishLeadTurnResult(
        connection.db,
        f.workspace.id,
        f.pin.intentId,
        f.owner.principal,
        f.binding,
        'Authorized answer',
        async () => {
          throw new Error('grant revoked')
        }
      )
    ).rejects.toThrow('grant revoked')
    expect(
      await connection.db.select().from(messages).where(eq(messages.channelId, f.topic.id))
    ).toHaveLength(1)
    const first = await publishLeadTurnResult(
      connection.db,
      f.workspace.id,
      f.pin.intentId,
      f.owner.principal,
      f.binding,
      'Authorized answer',
      async () => {}
    )
    expect(
      await publishLeadTurnResult(
        connection.db,
        f.workspace.id,
        f.pin.intentId,
        f.owner.principal,
        f.binding,
        'Authorized answer',
        async () => {}
      )
    ).toBe(first)
    // Publication identity includes exact answer bytes, including trailing whitespace.
    await expect(
      publishLeadTurnResult(
        connection.db,
        f.workspace.id,
        f.pin.intentId,
        f.owner.principal,
        f.binding,
        'Authorized answer\n',
        async () => {}
      )
    ).rejects.toThrow('RUNTIME_RESPONSE_INVALID')
    await expect(
      publishLeadTurnResult(
        connection.db,
        f.workspace.id,
        f.pin.intentId,
        f.owner.principal,
        f.binding,
        'Changed answer',
        async () => {}
      )
    ).rejects.toThrow('RUNTIME_RESPONSE_INVALID')
    const rows = await connection.db
      .select()
      .from(messages)
      .where(eq(messages.channelId, f.topic.id))
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === first)).toMatchObject({
      senderAgentId: f.lead.id,
      bodyText: 'Authorized answer',
      executionRef: f.binding.executionId,
      externalSessionRef: f.binding.runtimeSessionId,
    })
    expect(
      (
        await connection.db
          .select()
          .from(workspaceEvents)
          .where(eq(workspaceEvents.workspaceId, f.workspace.id))
      ).filter((event) => event.eventType === 'message.created')
    ).toHaveLength(2)
  })
  test('receipt recovery persists actual session binding after preparation expiry without inventing runtime state', async () => {
    const f = await fixture()
    await prepareLeadTurnRuntime(
      connection.db,
      f.workspace.id,
      f.pin.intentId,
      f.owner.principal,
      f.pin
    )
    await markLeadTurnDispatchPending(
      connection.db,
      f.workspace.id,
      f.pin.intentId,
      f.owner.principal,
      f.pin
    )
    await connection.db
      .update(leadTurnRuntime)
      .set({ preparationExpiresAt: new Date(0) })
      .where(eq(leadTurnRuntime.intentId, f.pin.intentId))
    expect(
      await recoverLeadTurnRuntimeBinding(
        connection.db,
        f.workspace.id,
        f.pin.intentId,
        f.owner.principal,
        f.binding
      )
    ).toMatchObject({ state: 'dispatch_pending', runtimeSessionId: f.binding.runtimeSessionId })
    expect(
      await readLeadTurnRuntime(connection.db, f.workspace.id, f.pin.intentId, f.owner.principal)
    ).not.toHaveProperty('observedAt')
    expect(
      await recoverLeadTurnRuntimeBinding(
        connection.db,
        f.workspace.id,
        f.pin.intentId,
        f.owner.principal,
        f.binding
      )
    ).toMatchObject({ state: 'dispatch_pending', dispatchId: f.binding.dispatchId })
    await expect(
      recoverLeadTurnRuntimeBinding(
        connection.db,
        f.workspace.id,
        f.pin.intentId,
        f.owner.principal,
        { ...f.binding, attemptId: `att_${'1'.repeat(26)}` }
      )
    ).rejects.toThrow('RUNTIME_RESPONSE_INVALID')
    expect(
      await connection.db.select().from(messages).where(eq(messages.channelId, f.topic.id))
    ).toHaveLength(1)
  })
  test('cancel request persists intention without inventing cancelling; revoked original actor stops mutation/publication', async () => {
    const f = await fixture()
    await prepareLeadTurnRuntime(
      connection.db,
      f.workspace.id,
      f.pin.intentId,
      f.owner.principal,
      f.pin
    )
    await observeLeadTurnRuntime(connection.db, f.workspace.id, f.pin.intentId, f.owner.principal, {
      ...f.binding,
      state: 'running',
      observedAt: new Date().toISOString(),
    })
    await requestLeadTurnCancellation(
      connection.db,
      f.workspace.id,
      f.pin.intentId,
      f.owner.principal
    )
    expect(
      await readLeadTurnRuntime(connection.db, f.workspace.id, f.pin.intentId, f.owner.principal)
    ).toMatchObject({ state: 'running', cancelRequestedAt: expect.any(String) })
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, f.workspace.id))
    await expect(
      requestLeadTurnCancellation(connection.db, f.workspace.id, f.pin.intentId, f.owner.principal)
    ).rejects.toThrow('unavailable')
  })
})
