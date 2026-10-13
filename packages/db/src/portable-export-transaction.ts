/**
 * Short READ COMMITTED orchestration transactions observe committed revocations before each
 * read. They release the connection before hooks and canonical REPEATABLE READ page snapshots.
 * No outer transaction reserves a pool connection while a page snapshot is opened.
 *
 * The final bounded record proof uses READ WRITE / REPEATABLE READ. It reuses canonical
 * authorization and projection, permits their share locks, and builds the document while
 * those locks are still held. Both phases write no application rows. A revocation committed
 * before the final snapshot is observed. Canonical share locks are held through construction;
 * other changes after that snapshot are ordered after its coherent authorization view.
 */
export const PORTABLE_EXPORT_TRANSACTION_CONFIG = Object.freeze({
  accessMode: 'read write',
  isolationLevel: 'read committed',
} as const)

/** Final record proof is coherent and permits the canonical readers' share locks, but writes no rows. */
export const PORTABLE_EXPORT_PROOF_TRANSACTION_CONFIG = Object.freeze({
  accessMode: 'read write',
  isolationLevel: 'repeatable read',
} as const)
