# M18.01.3 migration collision record

Recorded separately from the rollback evidence. This document does not renumber any migration. It
states the collision so root can order the stack.

## What this branch carries

- `packages/db/drizzle/0047_lead_turn_rollback_fence.sql`, with its `meta/0047_snapshot.json` and the
  `_journal.json` entry at idx 47, tag `0047_lead_turn_rollback_fence`.
- Its SQL adds five nullable columns to `app.lead_turn_intents`, four checks, and a BEFORE UPDATE
  trigger. The trigger function and trigger names are `lead_turn_intents_rollback_fence_immutable`.
- It has been applied only to local throwaway databases. No shared or production database has applied it.

## The collision

- PR #1229 (`feat/pi-requested-role-selection`) carries `0047_requested_role_model_selections.sql`.
  It adds `app.lead_turn_intents.requested_model_selections` and the check
  `lead_turn_intents_requested_models_valid`. Root has selected it as the canonical 0047.
- This branch's 0047 has the same index and a different tag. Both migrations touch
  `app.lead_turn_intents`, but their column and constraint names are disjoint.
- Root reports 0048–0051 as already stacked. This branch does not know their contents.

## Action taken here

None to the migration files. No renumbering, no re-journaling, and no edit to any applied history.

## Delta needed once #1229 is the predecessor

1. Rename `0047_lead_turn_rollback_fence.sql` to the next free index after the stack root selects,
   expected `0048_lead_turn_rollback_fence.sql` if 0048 is free. Otherwise use the next free index.
2. Restore `_journal.json` from the stack root selects. Append one entry with the new idx, the new tag
   and a later `when`.
3. Regenerate the snapshot so its `prevId` chains to the predecessor's snapshot. Keep the SQL unchanged.
4. Run `db:check` and `db:verify` on the stacked branch. Both must pass before any merge.

## Risk

If the stack adds another migration before this one lands, the index must be chosen again at that
time. The SQL does not depend on the index.
