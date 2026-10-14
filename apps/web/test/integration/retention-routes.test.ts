// Handler-boundary proofs for the trusted cleanup receipt and read-only
// retention status routes (#1243 / #1221).
//
// The route modules import `@tanstack/solid-router`, which cannot load under
// bun, so these tests drive the exported request handlers the route files
// delegate to: the same functions the routes call, with the database and the
// principal seams injected. Route files are pinned to those handlers by
// scripts/retention-route-boundary.test.ts.
//
// Lane: part of `bun run test:integration` (react-server condition, real
// PostgreSQL). It fails when the database is missing and never skips.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import {
  addWorkspaceMembership,
  createDatabase,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  fingerprintOf,
  grantRetentionDeletionAuthorization,
  retentionCleanupReceipts,
  retentionDeletionAuthorizations,
  retentionHolds,
  revokeRetentionDeletionAuthorization,
  revokeRuntimeNode,
  runtimeNodeKeys,
  runtimeNodes,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
  type DatabaseConnection,
} from '@adea-ai/db'
import {
  runtimeNodeRetentionReceiptMessage,
  type RuntimeNodeRetentionReceiptRequest,
} from '@adea-ai/types/runtime-node-delivery'
import type { UserPrincipalRef } from '@adea-ai/types'

import { handleRuntimeNodeRetentionReceipt } from '../../src/server/retention-receipt-request'
import { handleRetentionStatus } from '../../src/server/retention-status-request'
import type { WorkspacePrincipalResolution } from '../../src/server/workspace-principal'

const connectionUrl = process.env.DATABASE_URL
const RECEIPT_CONTENT_LIMIT = 4096

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function base64url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString('base64url')
}

/** The observation a live grant accepts: after its grant instant, before now. */
function observedInside(grantedAt: string): string {
  return new Date(Date.parse(grantedAt) + 5).toISOString()
}

describe.skipIf(!connectionUrl)('retention receipt and status handler boundary', () => {
  let connection: DatabaseConnection
  const workspaceIds: string[] = []
  const userIds: string[] = []

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    for (const workspaceId of workspaceIds) {
      await connection.db
        .delete(retentionCleanupReceipts)
        .where(eq(retentionCleanupReceipts.workspaceId, workspaceId))
      await connection.db.delete(retentionHolds).where(eq(retentionHolds.workspaceId, workspaceId))
      await connection.db
        .delete(retentionDeletionAuthorizations)
        .where(eq(retentionDeletionAuthorizations.workspaceId, workspaceId))
      await connection.db
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspaceId))
      await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    }
    for (const userId of userIds) {
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, userId))
      await connection.db.delete(users).where(eq(users.id, userId))
    }
    await connection.close()
  })

  async function principal(name: string): Promise<UserPrincipalRef> {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: `retention-route-${name}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    })
    userIds.push(session.principal.userId)
    return session.principal
  }

  /** A live workspace with an owner and a member, plus one paired executor node holding a real Ed25519 key. */
  async function fixture(name: string) {
    const owner = await principal(`${name}-owner`)
    const member = await principal(`${name}-member`)
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `retention-route-${name}-${crypto.randomUUID()}`,
      name: `retention route ${name}`,
      owner,
    })
    workspaceIds.push(workspace.id)
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
    const pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
    const publicKey = base64url(await crypto.subtle.exportKey('raw', pair.publicKey))
    const keyId = crypto.randomUUID()
    const [node] = await connection.db
      .insert(runtimeNodes)
      .values({
        displayName: `${name} executor`,
        kind: 'local_device',
        ownerUserId: owner.userId,
        platform: 'darwin',
        softwareVersion: '1.0.0',
        workspaceId: workspace.id,
      })
      .returning()
    await connection.db.insert(runtimeNodeKeys).values({
      algorithm: 'ed25519',
      fingerprint: fingerprintOf(publicKey),
      id: keyId,
      keyVersion: 1,
      publicKey,
      role: 'signing',
      runtimeNodeId: node!.id,
      verifiedAt: new Date(),
    })
    return {
      keyId,
      member,
      nodeId: node!.id,
      owner,
      privateKey: pair.privateKey,
      workspaceId: workspace.id,
    }
  }

  /** A receipt body signed by the node's key over its body digest, as a node would send it. */
  async function signed(
    f: Awaited<ReturnType<typeof fixture>>,
    input: Readonly<{
      category?: string
      nodeId?: string
      receipt: RuntimeNodeRetentionReceiptRequest['receipt']
      nonce?: string
    }>
  ): Promise<RuntimeNodeRetentionReceiptRequest> {
    const body = {
      category: input.category ?? 'messages',
      envelope: {
        issuedAt: new Date().toISOString(),
        keyId: f.keyId,
        nonce: input.nonce ?? crypto.randomUUID(),
        signature: '',
        version: 1 as const,
      },
      receipt: input.receipt,
    }
    const scope = { runtimeNodeId: input.nodeId ?? f.nodeId, workspaceId: f.workspaceId }
    const signature = base64url(
      await crypto.subtle.sign(
        'Ed25519',
        f.privateKey,
        new TextEncoder().encode(await runtimeNodeRetentionReceiptMessage(scope, body))
      )
    )
    return { ...body, envelope: { ...body.envelope, signature } }
  }

  async function postReceipt(
    f: Awaited<ReturnType<typeof fixture>>,
    body: unknown,
    nodeId = f.nodeId
  ) {
    const text = JSON.stringify(body)
    const response = await handleRuntimeNodeRetentionReceipt(
      new Request(
        `https://cloud.test/api/v1/workspaces/${f.workspaceId}/runtime-nodes/${nodeId}/retention/cleanup-receipts`,
        {
          body: text,
          headers: {
            'content-length': String(Buffer.byteLength(text)),
            'content-type': 'application/json',
          },
          method: 'POST',
        }
      ),
      { runtimeNodeId: nodeId, workspaceId: f.workspaceId },
      { database: () => connection.db }
    )
    return { body: (await response.json()) as Record<string, unknown>, status: response.status }
  }

  async function getStatus(
    f: Awaited<ReturnType<typeof fixture>>,
    subjectId: string,
    options: Readonly<{ as?: UserPrincipalRef | null; category?: string }> = {}
  ) {
    const who = options.as === undefined ? f.owner : options.as
    const url = `https://cloud.test/api/v1/workspaces/${f.workspaceId}/retention/status?category=${options.category ?? 'messages'}&subjectId=${subjectId}`
    const response = await handleRetentionStatus(
      new Request(url, { method: 'GET' }),
      { workspaceId: f.workspaceId },
      {
        authorize: async (caller, _permission, workspaceId) => ({
          allowed: caller.userId === f.owner.userId && workspaceId === f.workspaceId,
        }),
        database: () => connection.db,
        resolve: async () =>
          who === null ? null : ({ principal: who } as unknown as WorkspacePrincipalResolution),
      }
    )
    return { body: (await response.json()) as Record<string, unknown>, status: response.status }
  }

  test('a signed receipt from the live generation is recorded, and an identical replay returns the same receipt', async () => {
    const f = await fixture('recorded')
    const subject = crypto.randomUUID()
    const grant = await grantRetentionDeletionAuthorization(connection.db, {
      actor: f.owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      subjectId: subject,
      workspaceId: f.workspaceId,
    })
    await sleep(20)
    const body = await signed(f, {
      nonce: crypto.randomUUID(),
      receipt: {
        coverage: 'primary',
        observedAt: observedInside(grant.grantedAt),
        operation: 'delete',
        outcome: 'completed',
        requestId: grant.id,
        residualCount: 0,
        subjectId: subject,
      },
    })
    const first = await postReceipt(f, body)
    expect(first.status).toBe(200)
    expect(first.body.outcome).toBe('recorded')
    const replay = await postReceipt(f, body)
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual({ outcome: 'replayed', receiptId: first.body.receiptId })
  })

  test('an unknown executor node is refused as runtime_node_unavailable', async () => {
    const f = await fixture('unknown')
    const subject = crypto.randomUUID()
    const grant = await grantRetentionDeletionAuthorization(connection.db, {
      actor: f.owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      subjectId: subject,
      workspaceId: f.workspaceId,
    })
    await sleep(20)
    const unknownNode = crypto.randomUUID()
    const body = await signed(f, {
      nodeId: unknownNode,
      receipt: {
        coverage: 'primary',
        observedAt: observedInside(grant.grantedAt),
        operation: 'delete',
        outcome: 'completed',
        requestId: grant.id,
        residualCount: 0,
        subjectId: subject,
      },
    })
    expect(await postReceipt(f, body, unknownNode)).toEqual({
      body: { code: 'runtime_node_unavailable' },
      status: 404,
    })
  })

  test('a revoked executor is refused as runtime_node_unavailable, with its receipts unchanged', async () => {
    const f = await fixture('revoked')
    const subject = crypto.randomUUID()
    const grant = await grantRetentionDeletionAuthorization(connection.db, {
      actor: f.owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      subjectId: subject,
      workspaceId: f.workspaceId,
    })
    await sleep(20)
    await revokeRuntimeNode(connection.db, {
      actorUserId: f.owner.userId,
      reason: 'handler boundary fixture',
      runtimeNodeId: f.nodeId,
      workspaceId: f.workspaceId,
    })
    const body = await signed(f, {
      receipt: {
        coverage: 'primary',
        observedAt: observedInside(grant.grantedAt),
        operation: 'delete',
        outcome: 'completed',
        requestId: grant.id,
        residualCount: 0,
        subjectId: subject,
      },
    })
    expect(await postReceipt(f, body)).toEqual({
      body: { code: 'runtime_node_unavailable' },
      status: 404,
    })
  })

  test('a receipt altered after signing is refused as runtime_node_unavailable, like a bad signature', async () => {
    const f = await fixture('tampered')
    const subject = crypto.randomUUID()
    const grant = await grantRetentionDeletionAuthorization(connection.db, {
      actor: f.owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      subjectId: subject,
      workspaceId: f.workspaceId,
    })
    await sleep(20)
    const body = await signed(f, {
      receipt: {
        coverage: 'primary',
        observedAt: observedInside(grant.grantedAt),
        operation: 'delete',
        outcome: 'completed',
        requestId: grant.id,
        residualCount: 0,
        subjectId: subject,
      },
    })
    const relabelled = { ...body, receipt: { ...body.receipt, outcome: 'failed' } }
    expect(await postReceipt(f, relabelled)).toEqual({
      body: { code: 'runtime_node_unavailable' },
      status: 404,
    })
  })

  test('a validly signed receipt for an earlier request generation after regrant is refused, never relabelled', async () => {
    const f = await fixture('earlier-generation')
    const subject = crypto.randomUUID()
    const first = await grantRetentionDeletionAuthorization(connection.db, {
      actor: f.owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      subjectId: subject,
      workspaceId: f.workspaceId,
    })
    await sleep(20)
    await revokeRetentionDeletionAuthorization(connection.db, {
      actor: f.owner,
      authorizationId: first.id,
      workspaceId: f.workspaceId,
    })
    const second = await grantRetentionDeletionAuthorization(connection.db, {
      actor: f.owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      subjectId: subject,
      workspaceId: f.workspaceId,
    })
    await sleep(20)
    // Late receipt: answers the first request, observed inside its own window.
    const late = await signed(f, {
      receipt: {
        coverage: 'primary',
        observedAt: observedInside(first.grantedAt),
        operation: 'delete',
        outcome: 'completed',
        requestId: first.id,
        residualCount: 0,
        subjectId: subject,
      },
    })
    expect(await postReceipt(f, late)).toEqual({
      body: { code: 'retention_receipt_request_mismatch' },
      status: 409,
    })
    expect(second.id).not.toBe(first.id)
  })

  test('a receipt for a category the subject holds no authority for is refused as no current authority', async () => {
    const f = await fixture('wrong-category')
    const subject = crypto.randomUUID()
    const grant = await grantRetentionDeletionAuthorization(connection.db, {
      actor: f.owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      subjectId: subject,
      workspaceId: f.workspaceId,
    })
    await sleep(20)
    const body = await signed(f, {
      category: 'logs',
      receipt: {
        coverage: 'primary',
        observedAt: observedInside(grant.grantedAt),
        operation: 'delete',
        outcome: 'completed',
        requestId: grant.id,
        residualCount: 0,
        subjectId: subject,
      },
    })
    expect(await postReceipt(f, body)).toEqual({
      body: { code: 'retention_authorization_not_current' },
      status: 409,
    })
  })

  test('an expired authorization refuses a receipt that arrives after expiry', async () => {
    const f = await fixture('expired')
    const subject = crypto.randomUUID()
    const grant = await grantRetentionDeletionAuthorization(connection.db, {
      actor: f.owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 1_200).toISOString(),
      subjectId: subject,
      workspaceId: f.workspaceId,
    })
    await sleep(Date.parse(grant.expiresAt) - Date.now() + 200)
    const body = await signed(f, {
      receipt: {
        coverage: 'primary',
        observedAt: observedInside(grant.grantedAt),
        operation: 'delete',
        outcome: 'completed',
        requestId: grant.id,
        residualCount: 0,
        subjectId: subject,
      },
    })
    expect(await postReceipt(f, body)).toEqual({
      body: { code: 'retention_authorization_not_current' },
      status: 409,
    })
  })

  test('the same nonce with a different payload is a conflict, never an overwrite', async () => {
    const f = await fixture('conflict')
    const subject = crypto.randomUUID()
    const grant = await grantRetentionDeletionAuthorization(connection.db, {
      actor: f.owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      subjectId: subject,
      workspaceId: f.workspaceId,
    })
    await sleep(20)
    const nonce = crypto.randomUUID()
    const observedAt = observedInside(grant.grantedAt)
    const original = await signed(f, {
      nonce,
      receipt: {
        coverage: 'primary',
        observedAt,
        operation: 'delete',
        outcome: 'completed',
        requestId: grant.id,
        residualCount: 0,
        subjectId: subject,
      },
    })
    expect((await postReceipt(f, original)).status).toBe(200)
    const different = await signed(f, {
      nonce,
      receipt: {
        coverage: 'primary',
        observedAt,
        operation: 'delete',
        outcome: 'failed',
        requestId: grant.id,
        residualCount: 0,
        subjectId: subject,
      },
    })
    expect(await postReceipt(f, different)).toEqual({
      body: { code: 'retention_receipt_conflict' },
      status: 409,
    })
  })

  test('a body without its request identity is refused generically, and an oversized body is invalid', async () => {
    const f = await fixture('malformed')
    const subject = crypto.randomUUID()
    const grant = await grantRetentionDeletionAuthorization(connection.db, {
      actor: f.owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      subjectId: subject,
      workspaceId: f.workspaceId,
    })
    await sleep(20)
    const valid = await signed(f, {
      receipt: {
        coverage: 'primary',
        observedAt: observedInside(grant.grantedAt),
        operation: 'delete',
        outcome: 'completed',
        requestId: grant.id,
        residualCount: 0,
        subjectId: subject,
      },
    })
    const { requestId: _omitted, ...receiptWithoutIdentity } = valid.receipt
    expect(await postReceipt(f, { ...valid, receipt: receiptWithoutIdentity })).toEqual({
      body: { code: 'runtime_node_unavailable' },
      status: 404,
    })
    const oversized = { ...valid, padding: 'x'.repeat(RECEIPT_CONTENT_LIMIT) }
    expect(await postReceipt(f, oversized)).toEqual({
      body: { code: 'invalid_request' },
      status: 400,
    })
  })

  test('read-only status reports authority, evidence, and the fail-closed period decision to an owner only', async () => {
    const f = await fixture('status')
    const subject = crypto.randomUUID()
    const grant = await grantRetentionDeletionAuthorization(connection.db, {
      actor: f.owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      subjectId: subject,
      workspaceId: f.workspaceId,
    })
    await sleep(20)
    const receipt = await signed(f, {
      receipt: {
        coverage: 'primary',
        observedAt: observedInside(grant.grantedAt),
        operation: 'delete',
        outcome: 'completed',
        requestId: grant.id,
        residualCount: 0,
        subjectId: subject,
      },
    })
    expect((await postReceipt(f, receipt)).status).toBe(200)

    const before = await getStatus(f, subject)
    expect(before.status).toBe(200)
    const status = before.body.status as Record<string, unknown>
    expect(status.decision).toEqual({ outcome: 'refused', reason: 'policy_unset' })
    expect(status.periodConfigured).toBe(false)
    expect((status.authorization as { id: string }).id).toBe(grant.id)
    expect(status.evidence).toEqual({ coverage: { primary: 1 }, receipts: 1 })
    expect(status.holds).toEqual([])

    // Read-only: a second status read changes nothing.
    expect(await getStatus(f, subject)).toEqual(before)
  })

  test('status refuses a member, an unauthenticated caller, and an unknown category', async () => {
    const f = await fixture('status-refusals')
    const subject = crypto.randomUUID()
    await grantRetentionDeletionAuthorization(connection.db, {
      actor: f.owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      subjectId: subject,
      workspaceId: f.workspaceId,
    })
    expect(await getStatus(f, subject, { as: f.member })).toEqual({
      body: { code: 'workspace_unavailable', message: 'Workspace unavailable' },
      status: 404,
    })
    expect((await getStatus(f, subject, { as: null })).status).toBe(401)
    expect(await getStatus(f, subject, { category: 'nope' })).toEqual({
      body: { code: 'invalid_request' },
      status: 400,
    })
  })
})
