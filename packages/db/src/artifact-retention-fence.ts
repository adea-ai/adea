import { and, eq, isNull } from 'drizzle-orm'

import type { AgentHqTransaction } from './connection'
import {
  retentionCleanupReceipts,
  retentionDeletionAuthorizations,
  retentionDeletionDispatches,
} from './schema'

/**
 * The retention fence on artifact-reference registration (M18.02, #1221).
 *
 * The retention gate (`retention-cleanup`) refuses deletion while an artifact
 * has a live reference. That protects references registered BEFORE cleanup. This
 * module closes the other direction: once an artifact's deletion is authorized
 * or has begun, no new reference may be registered against it. This is a fence on
 * what the database records, not a proof that no live grant can reach data deleted
 * by a path that bypasses the gate: see "What it does not cover" below.
 *
 * The fence is closed, by name, in exactly three states:
 *
 * - `authority_live`: an unrevoked deletion authorization exists for the artifact
 *   in its source workspace. Expiry does not lift it. After expiry the executor
 *   can no longer record receipts, so a deletion that committed under the
 *   generation might have no evidence; only an explicit revocation lifts the
 *   fence, which is the one act that says nobody will delete under it.
 * - `deletion_dispatched`: a deletion dispatch mark exists under ANY generation for
 *   the artifact. The retention gate transaction that deletes writes the mark before
 *   it calls a store (`markDeletionDispatched`), so the mark commits with the
 *   deletion and cannot be missing when a deletion committed. It does not wait for a
 *   receipt and does not need a live generation, so revoking the generation (or its
 *   expiry) before any receipt is accepted leaves it in place. This is what closes
 *   the delete-then-revoke-before-receipt race.
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
 * artifact serialize on that lock for the whole of each other's transaction.
 *
 * - Registration first: the gate waits for it, then counts the committed grant
 *   as an active reference and refuses deletion.
 * - Gate first: registration waits for the gate's commit, then reads the
 *   authority and any evidence that gate left, and refuses.
 * - Authority or receipts written by other retention operations take only the
 *   per-subject advisory lock, never the artifact row. A registration that read
 *   `clear` just before an authority commits is not overtaken by a deletion,
 *   because that deletion needs the artifact row lock the registration still
 *   holds until commit.
 *
 * Lock order is unchanged: artifact row, then grant row (both
 * through `lockArtifactThenGrant`), then the issuer membership and workspace
 * share locks, then this lock-free read. The fence adds no lock, so it adds no
 * wait edge.
 *
 * What it does not cover. The mark is written by whoever deletes under
 * `withRetentionDeletionGate`; the cleanup executor does it for every store. A caller
 * that deletes artifact data without going through the gate, or a store whose effects
 * happen outside the gate transaction and survive its rollback, leaves no mark. Both
 * are rules about how a deleting path is written, not something this reader can see.
 * Deletions that committed before the dispatch table existed are likewise unmarked;
 * nothing deletes in production, and this change does not enable it.
 */

export type ArtifactRetentionFence =
  | 'authority_live'
  | 'deletion_dispatched'
  | 'cleanup_evidenced'
  | 'clear'

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
  const [dispatch] = await transaction
    .select({ id: retentionDeletionDispatches.id })
    .from(retentionDeletionDispatches)
    .where(
      and(
        eq(retentionDeletionDispatches.workspaceId, sourceWorkspaceId),
        eq(retentionDeletionDispatches.category, 'artifacts'),
        eq(retentionDeletionDispatches.subjectId, artifactId)
      )
    )
    .limit(1)
  if (dispatch) return 'deletion_dispatched'
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
