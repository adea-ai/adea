# M11 relay ciphertext retention: schema expansion

This is the additive first phase for #187/#189. Migration 0039 adds nullable
`task_submissions.ciphertext_purged_at`, the partial workspace/expiry/identity
index and a constraint refusing purge markers earlier than expiry. Existing
rows stay unmarked. No Task, outbox, node/key, event or canonical history row is
deleted or changed by the expansion.

## Two-phase rollout

The current main-push production migration and Worker workflows run independently.
An application that selects the new column could deploy before migration 0039
finishes. This first phase deliberately keeps all application/schema projections
unchanged; old application reads/writes remain compatible with the expanded
database. The bounded purge implementation is prepared separately in application
candidate `79a30fc36`, not activated here.

SQL, snapshot and journal were generated from that candidate's final Drizzle
declaration using `bun run --cwd packages/db db:generate -- --name=task-submission-ciphertext-retention`.
The generated snapshot intentionally precedes the runtime declaration during
this expansion phase. Do not generate new migrations from the older runtime
declaration until the application phase is integrated; it would propose removing
the expansion. This is temporary staging, not the final reconciled schema state.

Before the application phase merges, the approved deployment must establish:

1. Migration 0039 succeeds on the explicitly approved target and its idempotent
   rerun leaves migration history unchanged.
2. The nullable column, partial `task_submissions_ciphertext_expiry_idx` and
   `task_submissions_purge_after_expiry` constraint exist on that target.
3. The existing application still admits and reads retained intent correctly.
4. Only then deploy the matching runtime declaration and supported dry-run/apply
   operator. Configure scheduling separately; no cleanup runs in this phase.

Neither a merged PR nor a concurrent Worker deployment proves production schema
readiness. No production migration, key operation, scheduler activation, issue
closure or acceptance-ledger update is claimed by local validation.

## Hosted fixture correction

The earlier [Neon preview run](https://github.com/adea-ai/adea/actions/runs/37688227388)
at inventory candidate `32e34b680` failed the old-but-valid proof case. It left
one second of its unchanged 120-second replay window, and the proof correctly
expired during hosted database admission. The fixture now leaves 30 seconds,
still less than the 60-second rate window, and also asserts that retained rate
expiry exceeds the original proof expiry. Production proof validity, expiry
rejection, signature checks and rate limits are unchanged. Local checks do not
substitute for a new hosted preview run.

## Local validation — 2026-10-07

- `mise exec -- bun run test`: 30 successful Turbo tasks; the root coverage
  suite passes 302 tests / 7,127 assertions, with no threshold changes.
- `mise exec -- bun run build`: 15 successful tasks; the actual Worker build
  retains the existing application projections.
- `mise exec -- bun run lint`: 17 successful tasks plus the published root
  design-system check, zero errors or suppressions.
- `mise exec -- bun run format:check`: passes all 1,799 matched files.
- `mise exec -- bun run --cwd packages/db db:check`: passes.
- `mise exec -- bun run test:integration`: passes 110 tests / 1,820 assertions
  against an owned isolated PostgreSQL instance with migration 0039 applied.
  This runs existing intent admission/read, authenticated pull, scope/key
  changes and canonical state tests with the unchanged runtime declaration.
  Migration verification applies 40 migrations and its idempotent rerun passes.
  The database project/volume is removed and its allocated listener closes.
- `mise exec -- bun test scripts/docs-boundary.test.ts`: four tests / 15
  assertions pass. No relative documentation link is orphaned.

The separately prepared application candidate passes 118 isolated integration
tests / 1,878 assertions, including actual supported operator dry-run/apply,
concurrent claims, locked rows, rollback, no redelivery and slow-clock expired
reads. These results establish independent local behavior, not deployed host
interop, production schema readiness or configured retention scheduling.
