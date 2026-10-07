# M11 expired relay ciphertext retention

This application phase supports #187/#189 without claiming their complete
acceptance. It supplies a bounded workspace-scoped preview/apply operator and
reconciles the runtime declaration with migration 0039. The additive schema
phase is [PR #1153](https://github.com/adea-ai/adea/pull/1153); verify that phase
on the approved deployment before this application phase merges. The existing
main-push migration and Worker workflows do not guarantee deployment order.

## Implemented boundary

The database statement clock selects expired, unmarked Task submissions. An
atomic transaction locks the submission and linked outbox with `SKIP LOCKED`,
removes only `payload.envelope`, and records `ciphertext_purged_at`. Explicit
workspace UUIDs, limits of 1–1,000 and statement/lock deadlines bound the work.
Already-absent envelopes converge once. Locked rows remain eligible; a zero
count does not certify an empty backlog.

Intent identities/hash, selected node/profile, outbox statuses/attempts, Task
and execution state, keys, events and canonical history survive. Retried intent
retains its original identity. The durable marker keeps purged summaries expired
even when the application clock is behind the database. Cleanup neither
acknowledges delivery nor accepts, cancels or resubmits execution.

The supported [operator guide](../guides/relay-ciphertext-retention.md) documents
`bun run relay:purge`. It defaults to preview, requires exact host/port/database,
workspace and limit, and validates the private direct app-role connection before
creating a client. Hosted targets require TLS; endpoint overrides and Neon
poolers are refused. Output contains a bounded count or a fixed error code,
never ciphertext, a DSN or raw driver diagnostics. No scheduler is activated.

## Regression evidence and candidates

Application candidate `79a30fc36` passed 118 isolated PostgreSQL integration
tests / 1,878 assertions before integration with inventory main `001ae7149`.
The real database regression first failed against a no-op purge. A separate
slow-clock regression exposed a false pending-delivery summary after cleanup;
the durable-marker fix made that regression pass. The final suite exercises
preview without mutation, workspace/future isolation, concurrent bounded claims,
locked rows, rollback, the expiry constraint, already-absent envelopes, actual
operator target refusal/preview/apply and authenticated pull after cleanup.

The old-but-valid signed-proof fixture leaves 30 seconds of its unchanged
120-second validity window, less than the full 60-second rate window. Its old
one-second remainder expired during hosted database admission; the production
expiry refusal was correct. No signature, rate limit or production proof window
was widened. Fresh hosted-preview evidence remains required.

Current integrated-candidate checks are recorded separately below. Local checks
use an owned disposable PostgreSQL project with application and migration roles;
they do not use a shared or production database.

## Integrated-candidate validation

After integrating inventory main `001ae7149` without rewriting either branch:

- `mise exec -- bun run test`: 30 successful Turbo tasks; root coverage
  308 passed / zero failed / 7,183 assertions across 54 files.
- `mise exec -- bun run test:integration`: 118 passed / zero failed /
  1,878 assertions across 23 files. All 40 migrations applied and their
  idempotent rerun passed. The owned Compose project and volume were removed;
  the allocated listener was verified closed.
- `mise exec -- bun run lint`: 17 successful tasks and the root design-system
  enforcement passed with zero findings.
- `mise exec -- bun run build`: 15 successful tasks; all current integrated
  outputs were cached from the preceding unit-suite build.
- `mise exec -- bun run format:check`: passed on 1,805 matched files.
- `mise exec -- bun test scripts/docs-boundary.test.ts`: four passed /
  15 assertions.

There is no UI behavior change in this increment, so its local checks do not
repeat the inventory browser audit. Hosted preview, packaged desktop, live host
interop and manual product acceptance are not established by these results.

## Remaining acceptance

The schema phase merged as main `25264860b403f5f400ab9b4c933f06a15524cba3`.
That exact commit's [production migration job](https://github.com/adea-ai/adea/actions/runs/37698097521/job/113054687222)
and Worker deployment reported success. A subsequent read-only transaction on
the Adea project's production branch confirmed the nullable timestamptz column,
valid/ready partial expiry index, validated expiry constraint and exact 0039 SQL
hash in the 40-entry migration ledger. Project/branch/database metadata came from
the authenticated Neon CLI; the transaction was explicitly read-only with a
five-second statement deadline. Only catalog/migration metadata was read. No
Task/outbox/content rows, live cleanup, migration dispatch, credential change or
scheduler action was involved.

After integrating that main commit, both comment/documentation merge conflicts
were resolved without changing the retention behavior or production proof window.
The runtime declaration and the already-landed 0039 snapshot agree, and this
application diff now contains no migration SQL or snapshot change.

- `mise exec -- bun run test:unit`: 30 successful Turbo tasks; root coverage
  308 passed / zero failed / 7,188 assertions across 54 files.
- `mise exec -- bun run test:integration`: 118 passed / zero failed /
  1,878 assertions across 23 files; all 40 migrations and their idempotent rerun
  passed on an owned disposable target. Its project/volume and listener closed.
- `mise exec -- bun run lint`: 17 tasks plus root Oxlint, zero findings.
- `mise exec -- bun run typecheck`: 31 tasks passed in the integration commit hook.
- `mise exec -- bun run build`: 15 tasks passed, reusing the unit dependency builds.
- `mise exec -- bun run format:check`: 1,809 files passed before this evidence update.
- `mise exec -- bun run --cwd packages/db db:check`: passed.

Production migration/deployment verification, an authorized retention schedule,
and independent operational evidence remain required. Current-row removal is
not configured on production: the read-only role catalog found no `_app` role,
so the supported operator's application-role credential and activation still
require their own authorized setup. No role/password was created or changed.
Current-row removal is
not secure erasure from WAL, backups or replicas. Host inbox/replay, private-key
retention, supported Control Plane command/result interoperability, execution
acceptance/reconciliation and packaged/live certification remain their owning
lanes. No issue is closed or criterion marked verified by this increment.
