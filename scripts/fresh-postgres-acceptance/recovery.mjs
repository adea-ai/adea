// The recovery procedure of the Railway PostgreSQL target.
//
// Recovery is a forward-fix or a Railway backup/restore. There is no legacy
// artifact, no fallback to another provider and no compatibility path: an
// earlier artifact is not a recovery method here, so no such artifact is
// named, required or kept.
//
// The one artifact a recovery may name is the exact commit this lane tested.
// A procedure that names an untested commit is not a procedure, so the tested
// artifact is recorded here and every other commit is refused.

/** The recovery methods this procedure allows. */
export const RECOVERY_METHODS = Object.freeze(['forward-fix', 'railway-backup-restore'])

/**
 * The exact artifact this lane tested against PostgreSQL 18.
 *
 * The record states what was proved and where. It does not claim the hosted
 * target was read: the proof ran on a disposable loopback instance of the same
 * PostgreSQL major version, and the hosted target's own version, TLS mode and
 * privileges still need their own evidence.
 */
export const TESTED_RECOVERY_ARTIFACT = Object.freeze({
  commit: '333b948d4c5fba1f88d98d764c075b790be6ee22',
  source: 'origin/main',
  evidence: 'local-disposable',
  postgres: 'PostgreSQL 18 (digest-pinned postgres:18-alpine)',
  proved: Object.freeze([
    'the auth schema applies to an empty schema and replays as a no-op',
    'the application migration journal replays and compares against the current checkout',
    'the canonical migration and runtime roles are separated, and the runtime role cannot create objects',
    'a schema backup restores with the same tables, columns and rows into an empty database',
    'the owned disposable instance is removed on success, on failure and on interruption',
  ]),
  notProved: Object.freeze([
    'the hosted Railway instance was not read, and its version, TLS mode and pooling are unverified here',
    'the hosted target carries no data yet, so no data-loss estimate is available',
  ]),
})

/**
 * The recovery methods, refused and allowed.
 *
 * A method outside the list is refused, including the legacy artifact names a
 * rollback procedure would use.
 */
export function assertRecoveryMethod(method) {
  if (typeof method !== 'string' || !RECOVERY_METHODS.includes(method)) {
    throw new Error('unsupported recovery method: ' + String(method))
  }
  return method
}

/**
 * The artifact a recovery may name.
 *
 * Only the exact tested commit qualifies. Any other commit is refused until
 * it carries its own proof.
 */
export function assertTestedRecoveryArtifact(commit) {
  if (typeof commit !== 'string' || commit.trim() !== TESTED_RECOVERY_ARTIFACT.commit) {
    throw new Error(
      'recovery artifact is not the tested artifact; a different commit needs its own proof'
    )
  }
  return TESTED_RECOVERY_ARTIFACT
}

/**
 * The recovery plan for a target.
 *
 * Every entry names the method, the artifact the method works from and the
 * live action that needs root's approval. The plan is a procedure, not an
 * authorization: it starts nothing and changes nothing.
 */
export function recoveryPlan() {
  return {
    artifact: TESTED_RECOVERY_ARTIFACT,
    methods: [
      {
        method: 'forward-fix',
        steps: [
          'record the exact failing statement and the exact head that produced it',
          'apply the fix forward on a branch and prove it on a disposable instance of the same PostgreSQL major version',
          'run the schema initializer in plan mode against the target and read its output',
          'apply the initializer with the schema-owning migration role, then inspect again and require nothing pending',
          'run the migration checks against the target with the runtime and migration roles',
        ],
        liveAction:
          'the target apply and the re-inspection are root-owned live operations on the Railway instance',
      },
      {
        method: 'railway-backup-restore',
        steps: [
          'take a backup of the target schema and keep it with the receipt',
          'restore that backup into an empty schema on a disposable instance and compare tables, columns and rows',
          'restore the backup into a fresh schema on the target with the schema-owning migration role',
          'compare the restored schema against the backup before any traffic is pointed at it',
        ],
        liveAction:
          'the backup of the target and the restore into a fresh target schema are root-owned live operations',
      },
    ],
  }
}
