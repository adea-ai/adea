# Retention and trusted-cleanup gate

Issue #1221 (M18.02.1) defines a separate retention policy for each data category
and gates any deletion on verified cleanup. The implementation is
`packages/db/src/retention-policy.ts`. It is pure: candidates, receipts, the
trusted executor set, periods and the clock are injected. It deletes nothing,
contacts no executor and persists no receipts.

## Categories

| Category             | Required cleanup coverage               | Notes                                                       |
| -------------------- | --------------------------------------- | ----------------------------------------------------------- |
| `messages`           | primary, index, cache, replica          | Shared messages; never cascades into artifacts or evidence. |
| `contexts`           | primary, runtime_state, cache           | Private Agent context.                                      |
| `native_transcripts` | runtime_state, cache                    | Lives on the executing device; offline means pending.       |
| `receipts`           | primary, index                          | Audit and reconciliation evidence.                          |
| `artifacts`          | primary, object_version, cache, replica | Refused while referenced from another scope.                |
| `memory`             | primary, index, cache                   | Provenance is preserved by the owning memory policy.        |
| `logs`               | primary, index                          | Correlated operational records.                             |
| `backups`            | none per subject                        | Removed by backup expiry only; never verified per subject.  |

Coverage kinds are `primary`, `runtime_state`, `index`, `cache`, `object_version`
and `replica`, from REQ 142. The per-category sets are a proposal in code and
need review.

## Periods and holds

- Every period is `null` (unset) until approved. An unset period refuses deletion
  in that category (`policy_unset`). Nothing in this repository selects a period.
- `parseRetentionPeriods` accepts explicit `null` or a whole number of days from 1
  to 36,500. It rejects missing, extra and malformed categories.
- An active hold refuses deletion, even after expiry and even with verified
  cleanup. A hold is released by a timestamp that has passed.

## Decision order

`evaluateRetentionDeletion` checks, in order:

1. `policy_unset`: period is null.
2. `hold_active`.
3. `retention_period_running`: now is before anchor plus the period.
4. `active_reference_retained`: live references from other scopes remain.
5. `reconciliation_open`: an external effect or audit reconciliation is open.
6. `authorization_not_current`: the deletion request is not granted yet, has
   expired, or was revoked at or before now. Open-ended authority is not
   representable.
7. `backups` return `pending` with `backup_expiry`.
8. Cleanup coverage, from trusted receipts for this subject only:
   - no receipts: `cleanup_ready`. Cleanup may be dispatched; data is not gone.
   - a failed delete, or a read check with residual data: `refused` with `cleanup_failed`.
   - unreachable or in-progress executors, or missing verification: `pending`
     with typed blockers. An offline native executor stays pending.
   - a completed delete plus a later zero-residual read check for every required
     kind: `verified_complete`.

An executor counts only while it is authorized now and was authorized when it
observed the result. A revocation at or before now disqualifies all of that
executor's receipts, so its cleanup must be re-dispatched through a current
executor. Unknown, unauthorized, revoked, or out-of-window receipts are ignored
in evaluation and rejected by `recordCleanupReceipt`. Malformed receipts or
candidates throw `RetentionPolicyError` with a code only.

## Durable storage and the stored gate

Migration `0047_retention_cleanup_authority` adds three tables, and
`packages/db/src/retention-cleanup.ts` composes the pure gate over them:

- `retention_holds`: active while `released_at` is null.
- `retention_deletion_authorizations`: at most one unrevoked row per subject
  (partial unique index). Expiry is fixed, never open-ended.
- `retention_cleanup_receipts`: append-only rows bound to the recording runtime
  node, unique per workspace idempotency key.

Entry points, all typed through `RetentionCleanupError`:

- `grantRetentionDeletionAuthorization`, `revokeRetentionDeletionAuthorization`,
  `placeRetentionHold`, `releaseRetentionHold`: owner or admin of a live
  workspace, checked against membership at the moment of the act.
- `recordRetentionCleanupReceipt`: accepts only from a runtime node that
  `requireEligibleRuntimeNode` accepts now. The receipt's claimed executor must
  equal the authenticated node. A repeated key with the same payload replays;
  with a different payload it conflicts. A new receipt needs current authority.
- `withRetentionDeletionGate`: decides under locks and runs a callback with the
  decision while the locks are held, so a dispatch cannot act on a stale
  decision. `evaluateStoredRetentionDeletion` is the decision alone.

Time is the database clock. Every operation for one subject takes the same
transaction-scoped advisory lock. Artifact gates lock the artifact row first, in
the order reference registration uses. Active references for artifacts are the
live rows of `artifact_reference_grants`.

## Not implemented here

- Deletion execution, executors, backup expiry, export, or any scheduler. No
  caller dispatches cleanup, and no period is configured.
- Reference registration does not consult retention authority. A grant that
  commits after a `cleanup_ready` decision, and before any deletion, is not
  blocked by this slice.
- Non-artifact categories have no authoritative reference store yet, so their
  active-reference count is zero. The owning domain must supply
  `reconciliationOpen`.
- Receipts are append-only by API only. No database trigger enforces it.
- Existing workspace deletion refuses to proceed while holds, authorities, or
  receipts exist (`restrict` foreign keys).
- Changes to the existing relay ciphertext purge (`relay:purge`).

## Decisions needed before general release

1. Retention period in days for each of the eight categories, and the anchor
   timestamp each one runs from.
2. Backup retention and expiry duration (REQ 143).
3. The per-category coverage sets above.
4. Whether a rotated executor signing key keeps the node's earlier receipts
   countable. The gate currently counts receipts only from nodes with an active
   verified key, and judges them against the node's creation time.
5. Whether a reference stays active while any other scope holds it, or only
   while a live grant exists. The gate currently takes an injected count.
6. The maximum lifetime of a deletion authority. Only "expires after now" is
   enforced today.
7. Whether reference registration must refuse while a live deletion authority
   exists for the artifact (the gap noted under "Not implemented").
8. Whether workspace deletion should block on retention rows, or move them with
   an explicit cleanup procedure.
