# Retention period decision (#1221, #1243)

Status: open. Owner: root. No period, anchor, or backup duration has been chosen.

## Current behavior

- Every category's period is `null` (unset) in `UNSET_RETENTION_PERIODS`.
- With an unset period, every deletion is refused as `policy_unset`, in the pure
  gate, the stored gate, and `GET .../retention/status`.
- Configuration cannot introduce a period silently. `parseRetentionPeriods` only
  accepts explicit nulls or whole days from 1 to 36,500 for every category, and
  nothing reads a period from the environment.

## Decisions required

1. For each of the eight categories (`messages`, `contexts`, `native_transcripts`,
   `receipts`, `artifacts`, `memory`, `logs`, `backups`): the period in days, or
   an explicit decision to retain indefinitely.
2. For each category, the anchor the period runs from (the owning domain's
   timestamp, such as archive time or last activity). The status route cannot
   judge a configured period without it.
3. Backup retention and expiry duration (REQ 143).
4. Who may change a period, and the audit trail for the change.

## What must be true before any deletion

A period decision alone does not enable deletion. The trusted receipt path, the
authority checks, the hold checks, and an executor must all exist and be
verified. Setting a period does not dispatch or delete anything.
