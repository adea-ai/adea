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
//
// A receipt only qualifies when it is a passed, real database proof. A failed
// run, an incomplete run, a simulated run and a receipt of another kind name
// no artifact, and the guarantees below are the ones the receipt's own kind
// of proof supports, not a list stamped on every receipt.

import { assertEvidenceClass } from './evidence.mjs'
import { assertReproducibleProvenance } from './provenance.mjs'

/** The recovery methods this procedure allows. */
export const RECOVERY_METHODS = Object.freeze(['forward-fix', 'railway-backup-restore'])

/**
 * The database proofs a receipt may carry, and what each one observed.
 *
 * Each entry states the fields the receipt has to carry, and the guarantees
 * that those fields support. A receipt that does not carry them names no
 * artifact, so a guarantee is never stamped on a run that did not produce it.
 */
export const DATABASE_PROOFS = Object.freeze({
  'fresh-schema-acceptance': Object.freeze({
    observed: (receipt) =>
      Number.isInteger(receipt.migrations) &&
      receipt.migrations > 0 &&
      receipt.verificationRequired === true &&
      receipt.postgres === 'disposable-instance',
    guarantees: Object.freeze([
      'the auth schema applies to an empty schema and a second inspection reports nothing pending',
      'the application migration journal applies and replays against the same checkout',
      'the provider lifecycle and the desktop principal journey ran against the real database, and the receipt carries the measured counts',
    ]),
  }),
  'disposable-postgres-proof': Object.freeze({
    observed: (receipt) =>
      Array.isArray(receipt.migrations?.checks) &&
      receipt.migrations.checks.length > 0 &&
      receipt.auth?.applied === true &&
      receipt.auth?.replayApplied === false,
    guarantees: Object.freeze([
      'the auth schema applies to an empty schema and replays as a no-op',
      'the application migration journal applies and replays against the same checkout',
      'the canonical migration and runtime roles are separated, and the runtime role is refused object creation',
      'a schema backup restores with the same tables, columns and rows into an empty database',
      'the owned disposable instance is removed on success, on failure and on interruption',
    ]),
  }),
})

/**
 * What no proof showed.
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
 * Requires a receipt to be a passed, real database proof.
 *
 * This is the check a lane runs on its own receipt before it publishes it: a
 * receipt that the recovery procedure cannot consume is not a receipt. The
 * provenance is not part of it, because a receipt produced from a tree with
 * uncommitted changes is still a receipt; it just does not name an artifact.
 */
export function assertDatabaseProof(receipt) {
  if (receipt?.status !== 'passed') {
    throw new Error('the receipt is not a passed proof')
  }
  const proof = DATABASE_PROOFS[receipt?.proofKind]
  if (!proof) {
    throw new Error('the receipt is not a database proof')
  }
  const evidence = assertEvidenceClass(receipt?.evidence)
  if (evidence === 'simulated') {
    throw new Error('a simulated result does not prove a database')
  }
  if (!proof.observed(receipt)) {
    throw new Error('the receipt does not carry the result the proof observed')
  }
  return { proofKind: receipt.proofKind, evidence }
}

/**
 * The artifact a recovery may name, taken from a proof receipt.
 *
 * The receipt is the only source of the commit. The receipt has to be a
 * passed, real database proof, the provenance it carries has to be
 * reproducible, and the tree it exercised has to be the tree the code came
 * from.
 */
export function recoveryArtifact(receipt) {
  const { proofKind, evidence } = assertDatabaseProof(receipt)
  const exercised = assertReproducibleProvenance(receipt?.checkout)
  const module = assertReproducibleProvenance(receipt?.module)
  if (exercised.sha !== module.sha) {
    throw new Error('the receipt mixes two checkouts')
  }
  return {
    commit: exercised.sha,
    source: exercised.source,
    dirty: exercised.dirty,
    evidence,
    proofKind,
    proved: DATABASE_PROOFS[proofKind].guarantees,
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
