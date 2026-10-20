import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  createDatabase,
  createDirectAgentTopic,
  createLeadTurn,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  ensureWorkspaceLead,
  markLeadTurnDispatchPending,
  observeLeadTurnRuntime,
  prepareLeadTurnRuntime,
  leadChildPublications,
  messages,
  workspaceMemberships,
  workspaces,
  type DatabaseConnection,
} from '@adea-ai/db'
import { createLeadTurnProduct } from '../../src/server/lead-turn-product'
import type { LeadRuntimeAdapter } from '../../src/server/lead-turn-runtime'

const url = process.env.DATABASE_URL
const opaque = (prefix: string, digit: string) => `${prefix}_${digit.repeat(26)}`
const terminal = {
  delegationId: opaque('dlg', '1'),
  childExecutionId: opaque('exe', '2'),
  childAttemptId: opaque('att', '2'),
  role: 'researcher',
  state: 'completed' as const,
  resultRef: opaque('art', '3'),
  publication: 'published' as const,
}

describe.skipIf(!url)('connected child terminal to canonical timeline', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(url!)
  })
  afterAll(() => connection.close())

  async function fixture() {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      name: 'Child timeline',
      owner: owner.principal,
      idempotencyKey: crypto.randomUUID(),
    })
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    const topic = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      { title: 'Child timeline', idempotencyKey: crypto.randomUUID() }
    )
    const admitted = await createLeadTurn(connection.db, workspace.id, topic.id, owner.principal, {
      bodyText: 'Start child',
      idempotencyKey: crypto.randomUUID(),
    })
    const [canonicalWorkspace] = await connection.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id))
    const token = crypto
      .randomUUID()
      .replaceAll('-', '')
      .slice(0, 26)
      .toUpperCase()
      .replace(/[ILOU]/g, '0')
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
      schemaVersion: 'pi-lead-dispatch/v1' as const,
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
    let next = { ...terminal }
    let revoked = false
    let checks = 0
    const adapter = {
      async children() {
        return {
          ...binding,
          children: [
            {
              delegationId: terminal.delegationId,
              childExecutionId: terminal.childExecutionId,
              childAttemptId: terminal.childAttemptId,
              role: terminal.role,
              state: terminal.state,
              awaitingInput: false,
              stopRequested: false,
              acceptedAt: '2026-10-20T00:00:00.000Z',
              updatedAt: '2026-10-20T00:01:00.000Z',
              revision: 3,
              outcome: {
                state: terminal.state,
                resultRef: terminal.resultRef,
                publication: { status: 'published' },
              },
            },
          ],
          totalChildren: 1,
          complete: true,
        }
      },
      async childPublicationCurrent() {
        checks++
        if (revoked) throw new Error('CP_GRANT_REVOKED')
        return { ...next }
      },
      async dispatch() {
        throw new Error('not used')
      },
      async status() {
        throw new Error('not used')
      },
      async progress() {
        throw new Error('not used')
      },
      async cancel() {
        throw new Error('not used')
      },
    } as unknown as LeadRuntimeAdapter
    const product = createLeadTurnProduct(connection.db, { adapter })
    const scope = {
      workspaceId: workspace.id,
      intentId: pin.intentId,
      userId: owner.principal.userId,
    }
    return {
      owner,
      workspace,
      pin,
      binding,
      adapter,
      product,
      scope,
      checks: () => checks,
      revoke: () => {
        revoked = true
      },
      replace: (patch: Partial<typeof terminal>) => {
        next = { ...next, ...patch }
      },
    }
  }

  test('published CP child event becomes one canonical message across retries and a fresh product instance', async () => {
    const f = await fixture()
    expect(await f.product.publishChildren(f.scope)).toEqual({ published: 1 })
    const reopened = createDatabase(url!)
    try {
      const freshProduct = createLeadTurnProduct(reopened.db, { adapter: f.adapter })
      expect(await freshProduct.publishChildren(f.scope)).toEqual({ published: 1 })
    } finally {
      await reopened.close()
    }
    expect(f.checks()).toBe(4)
    const receipts = await connection.db
      .select()
      .from(leadChildPublications)
      .where(eq(leadChildPublications.intentId, f.pin.intentId))
    expect(receipts).toHaveLength(1)
    const emitted = await connection.db
      .select()
      .from(messages)
      .where(eq(messages.id, receipts[0]!.messageId))
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.bodyText).toBe('Child researcher completed.')
  })

  test('changed child outcome, revoked CP grant and removed audience append nothing', async () => {
    const f = await fixture()
    f.replace({ childAttemptId: opaque('att', '4') })
    await expect(f.product.publishChildren(f.scope)).rejects.toThrow()
    f.replace({ childAttemptId: terminal.childAttemptId })
    f.revoke()
    await expect(f.product.publishChildren(f.scope)).rejects.toThrow('CP_GRANT_REVOKED')
    expect(
      await connection.db
        .select()
        .from(leadChildPublications)
        .where(eq(leadChildPublications.intentId, f.pin.intentId))
    ).toHaveLength(0)
    const other = await fixture()
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, other.workspace.id))
    await expect(other.product.publishChildren(other.scope)).rejects.toThrow()
    expect(
      await connection.db
        .select()
        .from(leadChildPublications)
        .where(eq(leadChildPublications.intentId, other.pin.intentId))
    ).toHaveLength(0)
  })
})
