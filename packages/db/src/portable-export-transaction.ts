/**
 * READ COMMITTED, so each statement sees the commits made before it. Under REPEATABLE READ the
 * snapshot is fixed at the first statement, and a revocation committed mid-export would be
 * invisible to every later check. The families are therefore not one point-in-time snapshot;
 * the requester's access is checked before every message page and after the last read instead.
 *
 * READ WRITE, and it writes nothing. The canonical authority readers (#1237) take share row locks
 * (`FOR SHARE`) on the artifact and grant rows they depend on, and Postgres refuses row locks in
 * a READ ONLY transaction. The export holds those share locks until it commits or rolls back.
 * A revocation takes its grant row `FOR UPDATE`, so it waits for an export that holds the share
 * lock. An export that reads a grant before a revocation commits is therefore ordered before that
 * revocation, and a revocation committed before the read is observed and withholds the record. A
 * later export sees every revocation committed before it starts. A lock wait can delay the export
 * or the revocation; it cannot produce a partial document. A deadlock fails the export with its
 * own error and returns no document.
 */
export const PORTABLE_EXPORT_TRANSACTION_CONFIG = Object.freeze({
  accessMode: 'read write',
  isolationLevel: 'read committed',
} as const)
