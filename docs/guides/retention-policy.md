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
4. `shared_reference_retained`: live references from other scopes remain.
5. `reconciliation_open`: an external effect or audit reconciliation is open.
6. `backups` return `pending` with `backup_expiry`.
7. Cleanup coverage, from trusted receipts for this subject only:
   - no receipts: `cleanup_ready`. Cleanup may be dispatched; data is not gone.
   - a failed delete, or a read check with residual data: `refused` with `cleanup_failed`.
   - unreachable or in-progress executors, or missing verification: `pending`
     with typed blockers. An offline native executor stays pending.
   - a completed delete plus a later zero-residual read check for every required
     kind: `verified_complete`.

Receipts from untrusted executors are ignored in evaluation and rejected by
`recordCleanupReceipt`. Malformed receipts or candidates throw
`RetentionPolicyError` with a code only.

## Not implemented here

- Persisting receipts or any database migration.
- Executors, deletion execution, backup expiry, export, or any scheduler.
- Changes to the existing relay ciphertext purge (`relay:purge`).

## Decisions needed before general release

1. Retention period in days for each of the eight categories, and the anchor
   timestamp each one runs from.
2. Backup retention and expiry duration (REQ 143).
3. The per-category coverage sets above.
4. The trusted executor registry, and where receipts are stored.
5. Whether a shared artifact stays while any other scope references it, or only
   while a live grant exists.
