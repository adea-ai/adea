import { and, eq, isNull } from 'drizzle-orm'

import type { AgentHqTransaction } from './connection'
import { retentionCleanupReceipts, retentionDeletionAuthorizations } from './schema'

/**
 * The retention fence on artifact-reference registration (M18.02, #1221).
 *
 * The retention gate (`retention-cleanup`) refuses deletion while an artifact
 * has a live reference. That protects references registered BEFORE cleanup. This
 * module closes the other direction: once an artifact's deletion is authorized
 * or has been evidenced, no new reference may be registered against it. This is a
 * fence on what the database records, not a proof that no live grant can reach
 * deleted data: see "Known gap" below.
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
 * Known gap (production cleanup must stay disabled until it is closed). The fence sees
 * only authority and receipts. If a store deletes under a generation, and an
 * administrator revokes that generation before any of its receipts is accepted, the
 * database holds no trace of the deletion: receipts are accepted only against a live
 * generation, so the late evidence is refused, and the revoked generation no longer
 * fences. A registration after that point is accepted for deleted data. Ordering the
 * executor to submit receipts first is a convention, not a guarantee. Closing it needs
 * durable deletion evidence written inside the gate transaction that deletes (a
 * schema change) and fenced on here. Nothing deletes in production today, and this
 * change does not enable it.
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
