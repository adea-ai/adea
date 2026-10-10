# M18.01.3 migration collision record

Records how the rollback migration was placed in the canonical chain, and what root still has to decide.
It does not renumber any migration that exists on another branch.

## Reconciled state on this branch

- Canonical `0047_requested_role_model_selections`, `0048_graceful_prima`, `0049_group_participation_grants`
  and `0050_group_legacy_backfill` are imported byte-identical (SQL, snapshots, and their journal entries)
  from `origin/feat/group-participation-policy-1178`, which carries the same blobs as #1179. Commit
  `aba8805d7`.
- The rollback migration is `0051_lead_turn_rollback_fence`, the slot root reserved for it. Its SQL is
  byte-identical to the SQL first written as the local 0047.
- `meta/0051_snapshot.json` has `prevId` = canonical 0050 snapshot id `abcf1389-e765-4580-bf5b-5ce5379f6061`
  and a new id. Its only difference from canonical 0050 is the rollback delta on `app.lead_turn_intents`:
  five nullable columns and four checks.
- Journal idx 51 has tag `0051_lead_turn_rollback_fence` and `when` 1791610243414, later than canonical
  0050's 1791602651135. Canonical entries are unchanged; the only other journal change is the comma after
  the idx 50 entry.
- Snapshot 0051 was built by inserting text into the canonical 0050 bytes, not by drizzle-kit. See
  "Conflicts for root" below.

Proof of this state is in [m18-01-3-rollback-fencing.md](m18-01-3-rollback-fencing.md#validation).

## Conflicts for root

1. **#1177 (`feat/issue-1177-session-handoff`) collides with the 0051 slot.** That branch carries its own
   `0047_huge_hitman.sql`, which differs from canonical 0047, and its own `0051_lead_handoff_target.sql`.
   Its 0048 to 0050 files match canonical. This branch does not touch it. Its owner needs to renumber its
   handoff migration and reconcile its 0047 before it lands alongside this PR.
2. **Canonical schema source is not on this branch.** The TypeScript schema here has no
   `requested_model_selections` column and no group or role tables from canonical 0047 to 0050. Running
   `drizzle-kit generate` on this branch would propose drops, so the 0051 snapshot is hand-built. `db:check`
   validates snapshot lineage and journal consistency, not that the TypeScript schema matches the migrations.
   The owner of the canonical schema branch should confirm the snapshot against its own generate output.
3. **Ordering.** This PR's 0051 must land after canonical 0050. Any branch that adds a migration above 0046
   must pick its index after 0051, or after root moves it.
4. **Other branches with canonical blobs.** #1215 carries canonical 0047 and 0048 with identical bytes.
   #1229 carries canonical 0047 only. Neither conflicts with this branch, but each needs the same
   import-then-append ordering if it lands before #1232.

## Not touched

No other owner's branch, file, or journal was changed. No migration that exists on another branch was
renumbered, rewritten, or deleted.
