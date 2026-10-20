import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ensureWorkspaceLead } from '../../src/agents'
import {
  publishLeadChildTerminal,
  type LeadChildTerminalEvidence,
} from '../../src/lead-child-publications'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createDirectAgentTopic } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import {
  markLeadTurnDispatchPending,
  observeLeadTurnRuntime,
  prepareLeadTurnRuntime,
} from '../../src/lead-turn-runtime'
import { createLeadTurn } from '../../src/lead-turns'
import {
  leadChildPublications,
  messages,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const databaseUrl = process.env.DATABASE_URL
const id = (prefix: string, digit: string) => `${prefix}_${digit.repeat(26)}`
const completed: LeadChildTerminalEvidence = {
  delegationId: id('dlg', '1'),
  childExecutionId: id('exe', '2'),
  childAttemptId: id('att', '2'),
  role: 'researcher',
  state: 'completed',
  resultRef: id('art', '3'),
  publication: 'published',
}

describe.skipIf(!databaseUrl)('Adea child terminal publication receipt', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(databaseUrl!)
  })
  afterAll(() => connection.close())

  async function fixture() {
    const token = crypto
      .randomUUID()
      .replaceAll('-', '')
      .slice(0, 26)
      .toUpperCase()
      .replace(/[ILOU]/g, '0')
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      name: 'Child terminal receipt',
      owner: owner.principal,
      idempotencyKey: crypto.randomUUID(),
    })
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    const topic = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      { title: 'Child terminal receipt', idempotencyKey: crypto.randomUUID() }
    )
    const admitted = await createLeadTurn(connection.db, workspace.id, topic.id, owner.principal, {
      bodyText: 'Start one child',
      idempotencyKey: crypto.randomUUID(),
    })
    const [canonicalWorkspace] = await connection.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id))
    const pin = {
      workspaceId: canonicalWorkspace!.controlPlaneWorkspaceId,
      intentId: admitted.leadTurn.intentId,
      executionId: `exe_${token}`,
      attemptId: `att_${token}`,
      selectionRef: `msel_${'a'.repeat(32)}`,
      selectionRevision: 1,
      preparationRef: `prep_${'b'.repeat(32)}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }
    const binding = {
      intentId: pin.intentId,
      dispatchId: `dispatch_${crypto.randomUUID().replaceAll('-', '')}`,
      executionId: pin.executionId,
      attemptId: pin.attemptId,
      runtimeSessionId: `ses_${token}`,
    }
    await prepareLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, pin)
    await markLeadTurnDispatchPending(
      connection.db,
      workspace.id,
      pin.intentId,
      owner.principal,
      pin
    )
    await observeLeadTurnRuntime(connection.db, workspace.id, pin.intentId, owner.principal, {
      ...binding,
      state: 'running',
      observedAt: new Date().toISOString(),
    })
    const publish = (
      evidence: LeadChildTerminalEvidence = completed,
      grant: (transaction: unknown) => Promise<void> = async () => {}
    ) =>
      publishLeadChildTerminal(
        connection.db,
        workspace.id,
        pin.intentId,
        owner.principal,
        binding,
        evidence,
        grant
      )
    return { owner, workspace, lead, topic, admitted, pin, binding, publish }
  }

  test('an independent child completes after the lead is still running; one message/event/receipt survives replay', async () => {
    const f = await fixture()
    const first = await f.publish()
    expect(await f.publish()).toBe(first)
    expect(await Promise.all([f.publish(), f.publish()])).toEqual([first, first])
    const restarted = createDatabase(databaseUrl!)
    try {
      expect(
        await publishLeadChildTerminal(
          restarted.db,
          f.workspace.id,
          f.pin.intentId,
          f.owner.principal,
          f.binding,
          completed,
          async () => {}
        )
      ).toBe(first)
    } finally {
      await restarted.close()
    }
    const rows = await connection.db
      .select()
      .from(leadChildPublications)
      .where(eq(leadChildPublications.intentId, f.pin.intentId))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      delegationId: completed.delegationId,
      childAttemptId: completed.childAttemptId,
      messageId: first,
    })
    const timeline = await connection.db
      .select()
      .from(messages)
      .where(eq(messages.channelId, f.topic.id))
    expect(timeline).toHaveLength(2)
    expect(timeline.find((message) => message.id === first)).toMatchObject({
      bodyText: 'Child researcher completed.',
      senderAgentId: f.lead.id,
      executionRef: f.binding.executionId,
    })
    expect(JSON.stringify(timeline)).not.toContain(completed.resultRef)
    expect(
      (
        await connection.db
          .select()
          .from(workspaceEvents)
          .where(eq(workspaceEvents.workspaceId, f.workspace.id))
      ).filter((event) => event.eventType === 'message.created')
    ).toHaveLength(2)
  })

  test('grant failure, replay conflict, wrong binding and audience loss never append', async () => {
    const f = await fixture()
    await expect(
      f.publish(completed, async () => {
        throw new Error('grant revoked')
      })
    ).rejects.toThrow('grant revoked')
    expect(
      await connection.db
        .select()
        .from(leadChildPublications)
        .where(eq(leadChildPublications.intentId, f.pin.intentId))
    ).toHaveLength(0)
    const first = await f.publish()
    await expect(f.publish({ ...completed, childAttemptId: id('att', '5') })).rejects.toThrow(
      'CHILD_PUBLICATION_CONFLICT'
    )
    await expect(
      publishLeadChildTerminal(
        connection.db,
        f.workspace.id,
        f.pin.intentId,
        f.owner.principal,
        { ...f.binding, dispatchId: `dispatch_${'d'.repeat(32)}` },
        completed,
        async () => {}
      )
    ).rejects.toThrow('CHILD_PUBLICATION_WITHHELD')
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, f.workspace.id))
    await expect(f.publish()).rejects.toThrow('unavailable')
    expect(
      await connection.db
        .select()
        .from(leadChildPublications)
        .where(eq(leadChildPublications.intentId, f.pin.intentId))
    ).toHaveLength(1)
    expect(
      (await connection.db.select().from(messages).where(eq(messages.channelId, f.topic.id))).map(
        (message) => message.id
      )
    ).toContain(first)
  })

  test('failed and cancelled outcomes have distinct bounded timeline summaries', async () => {
    const f = await fixture()
    const failed = await f.publish({
      ...completed,
      delegationId: id('dlg', '6'),
      childAttemptId: id('att', '6'),
      childExecutionId: id('exe', '6'),
      state: 'failed',
      resultRef: undefined,
      failureCode: 'CHILD_RUNTIME_FAILED',
    })
    const cancelled = await f.publish({
      ...completed,
      delegationId: id('dlg', '7'),
      childAttemptId: id('att', '7'),
      childExecutionId: id('exe', '7'),
      state: 'cancelled',
      resultRef: undefined,
    })
    const rows = await connection.db
      .select()
      .from(messages)
      .where(eq(messages.channelId, f.topic.id))
    expect(rows.find((row) => row.id === failed)?.bodyText).toBe('Child researcher failed.')
    expect(rows.find((row) => row.id === cancelled)?.bodyText).toBe(
      'Child researcher was cancelled.'
    )
    expect(JSON.stringify(rows)).not.toContain('CHILD_RUNTIME_FAILED')
  })
})
