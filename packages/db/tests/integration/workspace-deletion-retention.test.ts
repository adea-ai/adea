import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

import { createDatabase, type AgentHqDatabase, type DatabaseConnection } from '../../src/connection'
import { mintControlPlaneIdentifier } from '../../src/control-plane-identifiers'
import { createTemporaryUserSession } from '../../src/identity'
import { createWorkspaceWithOwner, deleteWorkspace } from '../../src/workspaces'
import {
  authorizationAuditRecords,
  retentionCleanupReceipts,
  retentionDeletionAuthorizations,
  retentionDeletionDispatches,
  retentionHolds,
  runtimeNodes,
  workspaceDeletions,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'

const databaseUrl = process.env.DATABASE_URL

function postgresFailure(error: unknown): Readonly<{ code?: unknown; constraint?: unknown }> {
  let current = error
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') return {}
    const candidate = current as {
      cause?: unknown
      code?: unknown
      constraint?: unknown
      constraint_name?: unknown
    }
    if (candidate.code !== undefined)
      return {
        code: candidate.code,
        constraint: candidate.constraint ?? candidate.constraint_name,
      }
    current = candidate.cause
  }
  return {}
}

describe.skipIf(!databaseUrl)('retention evidence and permanent workspace deletion', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(databaseUrl!)
  })

  afterAll(async () => {
    await connection.close()
  })

  test('retention rows survive deletion refusal and foreign keys roll back a premature deletion receipt', async () => {
    const rollbackMarker = `rollback-retention-workspace-delete-${randomUUID()}`

    await expect(
      connection.db.transaction(async (transaction) => {
        // Nested database APIs use savepoints on the outer transaction. The final throw rolls
        // back every fixture row, including append-only cleanup-dispatch evidence.
        const scopedDatabase = transaction as unknown as AgentHqDatabase
        const owner = (
          await createTemporaryUserSession(scopedDatabase, {
            credentialDigest: `retention-delete-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 60_000),
          })
        ).principal

        const workspaceIdempotencyKey = `retention-delete-${randomUUID()}`
        const workspace = (
          await createWorkspaceWithOwner(scopedDatabase, {
            idempotencyKey: workspaceIdempotencyKey,
            name: 'Retention deletion fixture',
            owner,
          })
        ).workspace
        const subjectId = `workspace-${randomUUID()}`
        const [authorization] = await transaction
          .insert(retentionDeletionAuthorizations)
          .values({
            workspaceId: workspace.id,
            category: 'messages',
            subjectId,
            grantedByUserId: owner.userId,
            grantedAt: new Date(Date.now() - 1_000),
            expiresAt: new Date(Date.now() + 60_000),
          })
          .returning({ id: retentionDeletionAuthorizations.id })
        await transaction.insert(retentionHolds).values({
          workspaceId: workspace.id,
          category: 'messages',
          subjectId,
          placedByUserId: owner.userId,
        })

        await expect(
          deleteWorkspace(scopedDatabase, workspace.id, owner, {
            confirmationName: workspace.name,
            expectedVersion: workspace.version,
            device: true,
          })
        ).rejects.toThrow('cannot verify cleanup completion')
        expect(
          await transaction.select().from(workspaces).where(eq(workspaces.id, workspace.id))
        ).toHaveLength(1)
        expect(
          await transaction
            .select()
            .from(retentionDeletionAuthorizations)
            .where(eq(retentionDeletionAuthorizations.workspaceId, workspace.id))
        ).toHaveLength(1)
        expect(
          await transaction
            .select()
            .from(retentionHolds)
            .where(eq(retentionHolds.workspaceId, workspace.id))
        ).toHaveLength(1)
        expect(
          await transaction
            .select()
            .from(workspaceDeletions)
            .where(eq(workspaceDeletions.workspaceId, workspace.id))
        ).toEqual([])

        const [node] = await transaction
          .insert(runtimeNodes)
          .values({
            workspaceId: workspace.id,
            ownerUserId: owner.userId,
            controlPlaneRuntimeNodeRefId: mintControlPlaneIdentifier('rnr'),
            kind: 'local_device',
            displayName: 'Disposable retention fixture',
            platform: 'test',
            softwareVersion: 'test',
          })
          .returning({ id: runtimeNodes.id })
        await transaction.insert(retentionCleanupReceipts).values({
          workspaceId: workspace.id,
          runtimeNodeId: node!.id,
          authorizationId: authorization!.id,
          executorSigningFingerprint: 'disposable-fixture-fingerprint',
          idempotencyKey: `retention-delete-receipt-${randomUUID()}`,
          category: 'messages',
          subjectId,
          coverage: 'primary',
          operation: 'delete',
          outcome: 'completed',
          residualCount: 0,
          observedAt: new Date(),
        })
        await transaction.insert(retentionDeletionDispatches).values({
          workspaceId: workspace.id,
          authorizationId: authorization!.id,
          category: 'messages',
          subjectId,
          coverage: 'primary',
        })
        await transaction.insert(authorizationAuditRecords).values({
          workspaceId: workspace.id,
          principalKind: 'user',
          principalId: owner.userId,
          permission: 'workspace.delete',
          decision: 'allowed',
          reason: 'disposable retention fixture',
        })

        // Exercise the database operations used by the final deletion branch. If a retention FK
        // is lost, this succeeds and the test fails; on the current schema PostgreSQL refuses it.
        let deletionFailure: unknown
        try {
          await transaction.transaction(async (deletion) => {
            await deletion.insert(workspaceDeletions).values({
              workspaceId: workspace.id,
              ownerUserId: owner.userId,
              idempotencyKey: workspaceIdempotencyKey,
            })
            await deletion
              .delete(workspaceMemberships)
              .where(eq(workspaceMemberships.workspaceId, workspace.id))
            await deletion
              .delete(authorizationAuditRecords)
              .where(eq(authorizationAuditRecords.workspaceId, workspace.id))
            await deletion.delete(workspaces).where(eq(workspaces.id, workspace.id))
          })
        } catch (error) {
          deletionFailure = error
        }
        expect(postgresFailure(deletionFailure)).toMatchObject({
          code: '23001',
          constraint: expect.stringMatching(/^retention_/),
        })

        expect(
          await transaction.select().from(workspaces).where(eq(workspaces.id, workspace.id))
        ).toHaveLength(1)
        expect(
          await transaction
            .select()
            .from(workspaceDeletions)
            .where(eq(workspaceDeletions.workspaceId, workspace.id))
        ).toEqual([])
        expect(
          await transaction
            .select()
            .from(retentionDeletionAuthorizations)
            .where(eq(retentionDeletionAuthorizations.workspaceId, workspace.id))
        ).toHaveLength(1)
        expect(
          await transaction
            .select()
            .from(retentionHolds)
            .where(eq(retentionHolds.workspaceId, workspace.id))
        ).toHaveLength(1)
        expect(
          await transaction
            .select()
            .from(retentionCleanupReceipts)
            .where(eq(retentionCleanupReceipts.workspaceId, workspace.id))
        ).toHaveLength(1)
        expect(
          await transaction
            .select()
            .from(retentionDeletionDispatches)
            .where(eq(retentionDeletionDispatches.workspaceId, workspace.id))
        ).toHaveLength(1)
        expect(
          await transaction
            .select()
            .from(workspaceMemberships)
            .where(eq(workspaceMemberships.workspaceId, workspace.id))
        ).toHaveLength(1)

        throw new Error(rollbackMarker)
      })
    ).rejects.toThrow(rollbackMarker)
  })
})
