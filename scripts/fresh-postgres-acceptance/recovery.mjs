// The recovery procedure of the Railway PostgreSQL target.
//
// Recovery is a forward-fix or a Railway backup/restore. There is no legacy
// artifact, no fallback to another provider and no compatibility path: an
// earlier artifact is not a recovery method here, so no such artifact is
// named, required or kept.
//
// The one artifact a recovery may name is the artifact a proof receipt names.
// The receipt carries the provenance of the checkout it ran in, so the
// artifact is reproducible: the exact commit, a clean tree and the source it
// came from. A receipt without that provenance is refused, and no commit is
// written into this module as a constant that nobody can reproduce.

import { assertReproducibleProvenance } from './provenance.mjs'

/** The recovery methods this procedure allows. */
export const RECOVERY_METHODS = Object.freeze(['forward-fix', 'railway-backup-restore'])

/**
 * What a proved artifact was shown to do.
 *
 * The list describes the proof, not the target. Every entry was observed on a
 * disposable loopback instance of the pinned PostgreSQL image.
 */
export const PROVED_BY_THE_PROOF = Object.freeze([
  'the auth schema applies to an empty schema and replays as a no-op',
  'the application migration journal replays and compares against the current checkout',
  'the canonical migration and runtime roles are separated, and the runtime role cannot create objects',
  'a schema backup restores with the same tables, columns and rows into an empty database',
  'the owned disposable instance is removed on success, on failure and on interruption',
])

/**
 * What the proof did not show.
 *
 * The hosted target was not read, so its state is unknown. A state that was
 * not observed is not an empty one.
 */
export const NOT_PROVED_BY_THE_PROOF = Object.freeze([
  'the hosted Railway instance was not read: its PostgreSQL version, its TLS mode, its pooling behaviour and its plan are unverified here',
  "the hosted target's data state is UNKNOWN; the live target was not read, so no data-loss estimate is available and no assumption of an empty database is made",
  'no traffic was moved and no session was issued against the hosted target',
])

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
 * The artifact a recovery may name, taken from a proof receipt.
 *
 * The receipt is the only source of the commit. The provenance it carries is
 * required, so an artifact that nobody can reproduce is refused.
 */
export function recoveryArtifact(receipt) {
  const checkout = assertReproducibleProvenance(receipt?.checkout)
  return {
    commit: checkout.sha,
    source: checkout.source,
    dirty: checkout.dirty,
    evidence: receipt?.evidence,
    proved: PROVED_BY_THE_PROOF,
    notProved: NOT_PROVED_BY_THE_PROOF,
  }
}

/**
 * The artifact a recovery may name.
 *
 * Only an artifact a proof receipt names qualifies. Every other commit is
 * refused until it carries its own proof.
 */
export function assertTestedRecoveryArtifact(receipt) {
  return recoveryArtifact(receipt)
}

/**
 * The recovery plan for a target.
 *
 * Every entry names the method, the artifact the method works from and the
 * live action that needs root's approval. The plan is a procedure, not an
 * authorization: it starts nothing and changes nothing.
 */
export function recoveryPlan(receipt) {
  return {
    artifact: recoveryArtifact(receipt),
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
