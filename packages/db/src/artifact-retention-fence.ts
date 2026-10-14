import { and, eq, isNull } from 'drizzle-orm'

import type { AgentHqTransaction } from './connection'
import { retentionCleanupReceipts, retentionDeletionAuthorizations } from './schema'

/**
 * The retention fence on artifact-reference registration (M18.02, #1221).
 *
 * The retention gate (`retention-cleanup`) refuses deletion while an artifact
 * has a live reference. That protects references registered BEFORE cleanup. This
 * module closes the other direction: once an artifact's deletion is authorized
 * or has been evidenced, no new reference may be registered against it, so a
 * grant can never be committed to data that cleanup has deleted or is about to.
 *
 * The fence is closed, by name, in exactly two states:
 *
 * - `authority_live`: an unrevoked deletion authorization exists for the artifact
 *   in its source workspace. Expiry does not lift it. After expiry the executor
 *   can no longer record receipts, so a deletion that committed under the
 *   generation might have no evidence; only an explicit revocation lifts the
 *   fence, which is the one act that says nobody will delete under it.
 * - `cleanup_evidenced`: a `delete` receipt exists under ANY generation for the
 *   artifact, whatever its outcome. A failed, unreachable, or in-progress delete
 *   may have removed part of the data, and a revoked or superseded generation
 *   does not bring the data back, so evidence outlives the generation that
 *   produced it.
 *
 * Everything else is clear, including holds (they block deletion, not sharing),
 * authority or receipts of another category that happen to share the subject
 * string, and any other artifact in the same workspace.
 *
 * Locking. This reader takes NO lock of its own and must run inside the
 * registration transaction AFTER the artifact row lock. That is what makes a
 * plain read sufficient: the retention gate takes the same artifact row lock
 * first (`withRetentionDeletionGate`), so a gate and a registration for one
 * artifact are mutually exclusive for the whole of each other's transaction.
 *
 * - Registration first: the gate waits for it, then counts the committed grant
 *   as an active reference and refuses deletion.
 * - Gate first: registration waits for the gate's commit, then reads the
 *   authority and any evidence that gate left, and refuses.
 * - Authority or receipts written by other retention operations take only the
 *   per-subject advisory lock, never the artifact row. A registration that read
 *   `clear` just before an authority commits cannot be overtaken by a deletion,
 *   because that deletion needs the artifact row lock the registration still
 *   holds until commit.
 *
 * Lock order is unchanged and global: artifact row, then grant row (both
 * through `lockArtifactThenGrant`), then the issuer membership and workspace
 * share locks, then this lock-free read. The fence adds no lock, so it cannot
 * close a cycle.
 *
 * Not covered: a deletion that committed under a generation which was then
 * revoked before any receipt reached the database. Receipts are recorded only
 * against a live generation, so that evidence is refused and the fence cannot
 * see the deletion. The executor must have its receipts accepted before an
 * administrator revokes the generation it ran under. Nothing in this slice
 * deletes, so the case is not reachable in production today.
 */

export type ArtifactRetentionFence = 'authority_live' | 'cleanup_evidenced' | 'clear'

/** Read the fence for one artifact in its source workspace. See the module comment for locking. */
export async function readArtifactRetentionFence(
  transaction: AgentHqTransaction,
  sourceWorkspaceId: string,
  artifactId: string
): Promise<ArtifactRetentionFence> {
  const [authority] = await transaction
    .select({ id: retentionDeletionAuthorizations.id })
    .from(retentionDeletionAuthorizations)
    .where(
      and(
        eq(retentionDeletionAuthorizations.workspaceId, sourceWorkspaceId),
        eq(retentionDeletionAuthorizations.category, 'artifacts'),
        eq(retentionDeletionAuthorizations.subjectId, artifactId),
        isNull(retentionDeletionAuthorizations.revokedAt)
      )
    )
    .limit(1)
  if (authority) return 'authority_live'
  const [evidence] = await transaction
    .select({ id: retentionCleanupReceipts.id })
    .from(retentionCleanupReceipts)
    .where(
      and(
        eq(retentionCleanupReceipts.workspaceId, sourceWorkspaceId),
        eq(retentionCleanupReceipts.category, 'artifacts'),
        eq(retentionCleanupReceipts.subjectId, artifactId),
        eq(retentionCleanupReceipts.operation, 'delete')
      )
    )
    .limit(1)
  return evidence ? 'cleanup_evidenced' : 'clear'
}
