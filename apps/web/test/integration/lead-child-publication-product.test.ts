import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
import { createLeadChildReconcileHandler } from '../../src/server/lead-child-reconcile'
import { createLeadTurnSdkAdapter } from '../../src/server/lead-turn-sdk-adapter'
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
  conclusion: 'The requested answer is 42.',
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
    expect(emitted[0]!.bodyText).toBe('Child researcher completed: The requested answer is 42.')
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

  test('a retained CP wake publishes after browser absence and retries across a new handler', async () => {
    const f = await fixture()
    const makeHandler = () =>
      createLeadChildReconcileHandler({
        verify: async () => true,
        current: async (workspaceId, intentId) =>
          workspaceId === f.pin.workspaceId && intentId === f.pin.intentId ? f.scope : undefined,
        publish: async (scope) => {
          await f.product.publishChildren(scope)
        },
      })
    const wake = () =>
      new Request('https://adea.example/api/internal/pi-durable/child-receipt/reconcile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: f.pin.workspaceId,
          intentId: f.pin.intentId,
          principalId: 'svc_product-reader',
        }),
      })
    expect((await makeHandler()(wake())).status).toBe(204)
    expect((await makeHandler()(wake())).status).toBe(204)
    const receipts = await connection.db
      .select()
      .from(leadChildPublications)
      .where(eq(leadChildPublications.intentId, f.pin.intentId))
    expect(receipts).toHaveLength(1)
    expect(
      await connection.db.select().from(messages).where(eq(messages.id, receipts[0]!.messageId))
    ).toHaveLength(1)
  })

  test.skipIf(!process.env.PI_CP_SOURCE_ROOT)(
    'paired local CP notifier and Adea handler deliver one PG message through HTTP wire semantics',
    async () => {
      const source = pathToFileURL(
        join(
          process.env.PI_CP_SOURCE_ROOT!,
          'apps/control-api/src/pi-durable/child-timeline-delivery.ts'
        )
      ).href
      const { createPiChildTimelineHttpNotify } = await import(source)
      const f = await fixture()
      const handler = createLeadChildReconcileHandler({
        verify: async (request, workspaceId, principalId) =>
          request.headers.get('authorization') === 'Bearer aaa.bbb.ccc' &&
          workspaceId === f.pin.workspaceId &&
          principalId === 'svc_product-reader',
        current: async (workspaceId, intentId) =>
          workspaceId === f.pin.workspaceId && intentId === f.pin.intentId ? f.scope : undefined,
        publish: async (scope) => {
          const fresh = createDatabase(url!)
          try {
            await createLeadTurnProduct(fresh.db, { adapter: f.adapter }).publishChildren(scope)
          } finally {
            await fresh.close()
          }
        },
      })
      const notify = createPiChildTimelineHttpNotify({
        endpoint: 'https://adea.example/api/internal/pi-durable/child-receipt/reconcile',
        credentials: { getExistingCredential: async () => 'aaa.bbb.ccc' },
        fetch: async (requestUrl: URL, init: RequestInit) => handler(new Request(requestUrl, init)),
      })
      const wake = {
        workspaceId: f.pin.workspaceId,
        intentId: f.pin.intentId,
        principalId: 'svc_product-reader',
      }
      await notify(wake)
      await notify(wake)
      const receipts = await connection.db
        .select()
        .from(leadChildPublications)
        .where(eq(leadChildPublications.intentId, f.pin.intentId))
      expect(receipts).toHaveLength(1)
      const [message] = await connection.db
        .select()
        .from(messages)
        .where(eq(messages.id, receipts[0]!.messageId))
      expect(message?.bodyText).toBe('Child researcher completed: The requested answer is 42.')
    }
  )

  test.skipIf(!process.env.PI_CP_CANDIDATE_SDK_ROOT)(
    'installed local CP candidate SDK publication reaches one canonical PG timeline message',
    async () => {
      const sdkRoot = process.env.PI_CP_CANDIDATE_SDK_ROOT!
      const { ControlPlaneClient } = await import(
        pathToFileURL(join(sdkRoot, 'dist/index.js')).href
      )
      const { PublicContractFixtures } = await import(
        pathToFileURL(join(sdkRoot, '../contracts/dist/index.js')).href
      )
      const f = await fixture()
      const publication = {
        ...f.binding,
        schemaVersion: 'pi-child-publication/v1',
        workspaceId: f.pin.workspaceId,
        canonicalActorPrincipalId: `user:${f.owner.principal.userId}`,
        delegationId: terminal.delegationId,
        childExecutionId: terminal.childExecutionId,
        childAttemptId: terminal.childAttemptId,
        role: terminal.role,
        state: terminal.state,
        resultRef: terminal.resultRef,
        conclusion: terminal.conclusion,
        occurredAt: new Date().toISOString(),
        authorityRevision: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
      const client = new ControlPlaneClient({
        baseUrl: 'https://control-plane.example',
        credential: 'synthetic-service-credential',
        fetch: async (_url: URL, init: RequestInit) => {
          const request = JSON.parse(String(init.body)) as Record<string, unknown>
          return new Response(
            JSON.stringify({
              contractVersion: request.contractVersion,
              requestId: request.requestId,
              correlation: request.correlation,
              data: { publication },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        },
      })
      const { projectId: _, ...read } = PublicContractFixtures.request
      const candidate = createLeadTurnSdkAdapter({
        workspaceId: f.pin.workspaceId,
        dispatch: async () => ({}),
        status: async () => ({}),
        progress: async () => ({}),
        cancel: async () => ({}),
        childPublicationCurrent: (dispatchId, preparationRef, delegationId) =>
          client.getPiDurableChildPublication({
            ...read,
            workspaceId: f.pin.workspaceId,
            operation: 'pi-durable.child.publication.current',
            parameters: { dispatchId, preparationRef, delegationId },
          }),
      })
      const product = createLeadTurnProduct(connection.db, {
        adapter: { ...f.adapter, childPublicationCurrent: candidate.childPublicationCurrent },
      })
      expect(await product.publishChildren(f.scope)).toEqual({ published: 1 })
      expect(await product.publishChildren(f.scope)).toEqual({ published: 1 })
      const [receipt] = await connection.db
        .select()
        .from(leadChildPublications)
        .where(eq(leadChildPublications.intentId, f.pin.intentId))
      expect(receipt).toBeDefined()
      const [message] = await connection.db
        .select()
        .from(messages)
        .where(eq(messages.id, receipt!.messageId))
      expect(message?.bodyText).toBe('Child researcher completed: The requested answer is 42.')
    }
  )
})
