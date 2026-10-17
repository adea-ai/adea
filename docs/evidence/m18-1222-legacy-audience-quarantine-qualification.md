# M18 #1222 legacy-audience quarantine qualification

This evidence records a disposable PostgreSQL rehearsal of migration
`0058_legacy_audience_quarantine`. It is synthetic evidence for the migration,
snapshot contract and denial gates; it does not establish production data
correctness or production rollout readiness.

## Reproduce

From the repository root, with Docker available, run:

```sh
node scripts/run-with-capture-provisioning.mjs -- bun --conditions=react-server test packages/db/tests/integration/migration-canonical-legacy-quarantine-qualification.test.ts
```

The runner provisions and removes a dedicated disposable PostgreSQL instance
and sets `MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL`. Without that URL or the
provisioned runner the qualification is skipped, which is not a passing result.
The test creates and drops only databases named with the
`rehearsal_1222qual_` prefix. The measured run below used a parent-owned,
trust-only, loopback PostgreSQL 16 scratch instance. No production database or
credentials were read, and no production migration ran.

The harness first applies the canonical historical journal through 0046 and
writes synthetic participants, grants, a message and channel/thread read
states before 0049/0050 create the derived group authority. It then advances
the schema through 0057 and tests 0058 from that exact pre-migration state. The
participants include a removed workspace user, a cross-workspace Agent,
archived and configuration-error Agents, an archived group and clean active
principals.
It emits one `M18_1222_QUALIFICATION` JSON record with schema version 3,
table counts and SHA-256 digests, rollback results, lock waits and replay
results.

The recorded combined run also included the cutover rehearsal, the standalone
legacy quarantine fixture, canonical product-read gates and product-boundary
gate. It completed with 71 passing tests, 0 failures and 538 assertions:

```sh
node scripts/run-with-capture-provisioning.mjs -- bun --conditions=react-server test \
  packages/db/tests/integration/migration-cutover-rehearsal.test.ts \
  packages/db/tests/integration/migration-canonical-legacy-product-read.test.ts \
  packages/db/tests/integration/migration-canonical-legacy-audience-quarantine.test.ts \
  packages/db/tests/integration/migration-canonical-legacy-product-gate.test.ts \
  packages/db/tests/integration/migration-canonical-legacy-quarantine-qualification.test.ts
```

## Observed data reconciliation

The run began with 10 legacy participant rows. A deliberately pre-existing
writer changed one row's `updated_at` by one microsecond before the migrator
could acquire its locks. Its digest changed from
`2283375bd17a55f46afcd06f244fd104886bc66a64d325a959e40c0f30b8b756` to
`889d2baab3867b3bed2be472a24c4f16b428d1c2d50e0732c40476c7d1524f39`.
Migration 0058 preserved all 10 rows and the post-writer digest exactly; it did
not overwrite the concurrent committed source change.

The table records this combined run's exact SHA-256 values. Each fresh
disposable rehearsal generates new synthetic identifiers, so its emitted
digests differ while the same counts, classification, preservation and
withdrawal assertions are checked.

| Evidence                | Before 0058                                                            | After 0058                                                            | Result                                                           |
| ----------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `channel_participants`  | 10; `889d2baab3867b3bed2be472a24c4f16b428d1c2d50e0732c40476c7d1524f39` | 10; same digest                                                       | Source rows preserved after the pre-existing writer committed    |
| `messages`              | 1; `e02f3681191ee3f362930092fcf3458e3ccbc8e739ec928863b611d5e9eecbdc`  | 1; same digest                                                        | Preserved                                                        |
| Channel read states     | 1; `1ee58d759cdcc5f6377d5aa537767d554e90ab582e83d20eb14893717fbd499d`  | 1; same digest                                                        | Preserved                                                        |
| Thread read states      | 1; `dab81951d474084327627af82e59651c99b9807ce7de4ff8da64d19d88bae432`  | 1; same digest                                                        | Preserved                                                        |
| Group admissions        | 7; `597456e8136391600e191354e725bc0e50633706cae10e2d1390a2ff1617b372`  | 3; `6e06833cdeec1335b58ad9f035895b663fed4a941a397ebc0643bd10409dfafe` | Four ambiguous admissions withdrawn                              |
| User audience grants    | 3; `c3ae1d705c350c4b7f5ea67805852e6f249e57f51861360e3dbcd51c6abbfd55`  | 2; `5a288f374e6d30f2666699c972020dc7ddaa10cf8d780ed7e01e16cd5b50d6fd` | One ambiguous grant withdrawn                                    |
| Agent enlistment grants | 4; `a3d06ec21a2925cf051cf5921211cef01571aa196bb0e9f21522220269ad1942`  | 1; `d6092fb42e9dcd2008af175bf15298e1c336f011fda71684272566ca972f999b` | Three ambiguous grants withdrawn                                 |
| Quarantine              | Absent before 0058                                                     | 7; `23f820cf681c705e3e62b193e9439ab932c671e4230d13cb763d3c2472ddcc82` | All seven rows have withdrawal digests and source reconciliation |

The seven quarantine reasons were `agent_not_active` (2),
`agent_workspace_mismatch` (1), `group_channel_not_active` (3), and
`user_not_workspace_member` (1). The active same-workspace Agent remained
admitted. The archived and configuration-error Agents were classified as
`agent_not_active`. Stored source timestamps matched UTC microsecond precision,
and the stored source digest matched the unchanged participant row.

## Failure and concurrency observations

The injected post-withdrawal failure rolled back source and derived table
counts/digests, the migration journal, quarantine DDL and triggers, and
instrumentation writes. A subsequent retry completed and a repeat migration
produced the same nonempty quarantine digest and the same snapshot records.

The lock-order rehearsal first holds a membership write lock, then queues a
channel write behind migration 0058's earlier channel lock. PostgreSQL selected
the migration as the deadlock victim in this run. The older writer committed;
the migration was not journaled, its DDL and instrumentation rolled back, and
the source/authority evidence remained unchanged. `pg_locks` observed both
sides queued; the membership wait lasted 1002 ms and the writer's channel wait
996 ms before deadlock resolution. This documents a real retry case: the
migration lock order is not universally deadlock-free. Production rollout must
quiesce writes or use a reviewed retry window; it must not interpret a deadlock
abort as a partially applied migration.

For the successful controlled-lock run, the migration held all seven expected
`SHARE ROW EXCLUSIVE` table locks. An older source writer waited 5 ms before
committing. A direct authority-restoration insert queued while the migration
held its locks, then returned zero rows after commit; no admission was restored.
The controlled test latch lasted 16 ms. The read-only lock probe waited 22 ms
including the latch and 13 ms excluding its measured overlap. From lock
acquisition to migration return was 32 ms, of which 16 ms was the intentional
latch hold; the full migration call took 52 ms. These are observations from a
small synthetic dataset, not production estimates.

## Product and snapshot boundaries

The companion canonical product-gate suite verifies denial for direct-ID and
fan-out reads (history, search, inbox/read state, account summary and workspace
events), append/edit/delete and generic status/payload writes, joins and
attempted restoration. Clean principals retain their access. Archived and
configuration-error Agent cases are also covered by the migration gate.

Migration-snapshot format v3 captures all stored quarantine provenance and
withdrawal fields. Before schema 0058, the family is explicitly `unknown` with
`schema_absent`; changing or removing provenance is determinate snapshot drift.
Format-v2 snapshots are deliberately rejected as incompatible instead of being
coerced into equivalence. The portable-export policy remains separate and
continues to exclude this authority evidence under its existing
`authority_grants` classification.

## Remaining rollout qualification

This rehearsal does not inspect production's applied ledger or historical
participants, estimate production-sized lock duration, test a production
traffic profile, or verify the live migration/runtime role ownership and
connection arrangement. Before rollout, reconcile the exact production ledger
and candidate rows, validate the deployed role split, plan write quiescence or
retry behavior, and measure lock impact on a representative data copy. No
production migration, rollback, deployment or access change was performed.
