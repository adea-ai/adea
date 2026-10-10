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
8. Cleanup coverage, from receipts that match this subject, this category, and
   this deletion generation, were observed inside the generation's window and
   not after now, and came from a trusted executor. A read must be strictly
   later than its delete. Two conflicting results at the newest instant are
   `ambiguous_order`: no trusted sequence orders them, so neither is taken.
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

Migration `0052_retention_cleanup_authority` adds three tables, and
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
  equal the authenticated node. A receipt binds to the live deletion generation
  (`authorization_id`), and a payload naming another category or generation is
  refused (`receipt_request_mismatch`). A receipt observed after now, or before
  its generation was granted, is refused (`receipt_outside_window`). A repeated
  key with the same payload replays; with a different payload it conflicts. A
  new receipt needs current authority.
- Clock skew: there is no tolerance. An executor whose clock runs ahead of the
  database clock has its evidence refused. Choosing a tolerance is a product
  decision.
- `withRetentionDeletionGate`: decides under locks and runs a callback with the
  decision while the locks are held, so a dispatch cannot act on a stale
  decision. `evaluateStoredRetentionDeletion` is the decision alone.

Time is the database clock. Every operation for one subject takes the same
transaction-scoped advisory lock. Artifact gates lock the artifact row first, in
the order reference registration uses. Active references for artifacts are the
live rows of `artifact_reference_grants`.

Numbering: 0052 is reserved for retention after the canonical 0047-0051 chain
(#1229, #1230, #1232, #1244). Its journal `when` is later than 0051's, which
drizzle requires for the migration to be applied on an upgraded database. The
snapshot chains to the canonical 0051 snapshot, so it is valid only once that
chain lands unchanged. Until then, do not run `db:generate` on this branch: the
branch source does not contain the canonical group and rollback schema, so a
diff would propose dropping those tables.

## HTTP boundary (#1243)

Two handlers expose this slice. Route files only delegate to them, and
`scripts/retention-route-boundary.test.ts` pins that.

- `POST /api/v1/workspaces/{workspaceId}/runtime-nodes/{runtimeNodeId}/retention/cleanup-receipts`
  is node-authenticated, with no user session. The node signs an envelope
  (`keyId`, `nonce`, `issuedAt`, `signature`) with its active signing key. The
  purpose is `retention.cleanup_receipt`, and the signed bytes include a SHA-256
  digest of the category and receipt. The envelope nonce is the receipt's
  idempotency key. Envelope failures return `runtime_node_unavailable` (404) for
  an unknown, unpaired, revoked, or unsigned node, the same as a pull. Gate
  refusals return `retention_<code>` (409), for example
  `retention_receipt_request_mismatch`, `retention_authorization_not_current`,
  or `retention_receipt_conflict`. A malformed body or an oversized body returns
  `invalid_request` (400).
- `GET /api/v1/workspaces/{workspaceId}/retention/status?category=&subjectId=`
  is read-only, owner or admin only, through the existing `runtime.invoke`
  privilege. No permission is minted. It reports the live authority, holds,
  evidence counts for the live generation, and the period decision. While a
  period is unset the decision is `refused: policy_unset`. A configured period
  reports `undetermined: anchor_required`, because the owning domain's anchor is
  not part of this read.

These routes do not dispatch cleanup, and no period is configured. The period
decision is recorded separately in `docs/guides/retention-period-decision.md`.

## Source-level cleanup executor (#1243)

`runRetentionCleanupExecutor` (`packages/db/src/retention-cleanup-executor.ts`)
composes a cleanup run behind the gate. The gate decides under the subject lock,
and only `cleanup_ready` with a live generation reaches a store. Deletion and
read-back run in the gate's transaction. Receipts are submitted after the commit,
through the caller's signed submission port, and each one waits until the
database clock has passed its observation.

- Each required coverage kind is a `RetentionCleanupStorePort` (delete and
  residual count). The executor fails before the gate if a port is missing.
- A store that does not complete stops the run, so later stores keep their data.
  A residual after read-back stops it as well.
- The delete observation precedes its own deletion. The read-back observation is
  strictly later, which is what the gate's ordering requires.
- Holds, revocations, reference registrations, and reconciliation changes for the
  subject block on the gate's lock and serialize against the commit.

What this slice does not establish: a reference registered after the commit is
not fenced by retention authority. Verification is still refused while the
reference lives, but replicas that were already deleted are not restored. Fencing
registration needs a change in the grant module, which another owner maintains.
This is a decision for root.

The executor is exercised only against owned replicas in a disposable schema. No
production store is wired, no period is chosen, and nothing is scheduled.

## Not implemented here

- Deletion execution, executors, backup expiry, export, or any scheduler. No
  caller dispatches cleanup, and no period is configured.
- Grant, revoke, hold, and release routes. Only receipt submission and status are wired.
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
