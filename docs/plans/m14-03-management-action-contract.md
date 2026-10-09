# M14.03 management-action contract: #1218 on top of #1215

- Status: implemented on the stacked lane (2026-10-09).
- Lane: **#1218** — preserve memory provenance/audience and explicit project
  state promotion; preview sensitive/dirty-worktree cleanup.
- Sibling: **#1215** — route management through shared audited APIs
  (`feat/issue-1215-management-audit-apis`, commit `8364b2865`, PR #1230).
- Stacking: this branch is rebased onto `8364b2865`, so PR #1227's diff
  shrinks to this lane's single commit once #1230 merges. Both slices target
  `main`.
- Contract sources: REQ 022,033,050,052–058,086,087; tests A11,A14,A33,A35;
  reuse gate [#811](https://github.com/adea-ai/adea/issues/811).

## Ownership map (this lane)

| Source                                                                                          | Notes                                                                                       |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/desktop/shell/src/memory/provenance.ts`                                                   | Memory provenance/audience guard; `memory/store.ts` calls the decision directly.            |
| `apps/desktop/shell/src/dev-runtime/worktrees/cleanup-preview.ts`                               | Pure read-only preview; both cleanup gates, stale-write and recovery projections.           |
| `apps/desktop/shell/src/dev-runtime/worktrees/cleanup-plan.ts`                                  | Canonical destructive-selection gate shared by the executor and the preview.                |
| `apps/desktop/shell/src/dev-runtime/resources/policy.ts`                                        | Canonical policy expiry/standing decision; malformed expiry or clock fails closed.          |
| `packages/db/src/project-state-policy.ts`                                                       | Promotion decision plus the canonical project/channel state transitions (lock order + CAS). |
| `packages/db/src/agent-persona-policy.ts`                                                       | Persona guard; `changeAgentProfile` calls it before the UPDATE.                             |
| `apps/desktop/tests/{memory-provenance,worktree-cleanup-preview,dev-runtime-resources}.test.ts` | Provenance, cleanup preview/gates, expiry fail-closed tests.                                |
| `packages/db/tests/unit/{project-state-policy,agent-persona-policy}.test.ts`                    | Pure policy tests.                                                                          |
| `packages/db/tests/integration/project-state-promotion.test.ts`                                 | Promotion, archive provenance, concurrent promotion and channel-restore race.               |
| `apps/web/test/project-promotion-management.test.ts`                                            | Authorization, revision and confirmation through the shared gateway.                        |

## What this lane consumes from #1215

`packages/types/src/management.ts`, `apps/web/src/server/management-gateway.ts`,
`management-operations.ts`, `management-composition.ts` and
`lead-management-tools.ts` are the sibling's shared surface. This lane adds
one inventory entry and wires the promotion through the same gateway; it does
not fork the gateway, authorization or audit paths.

## What this lane lands on top of #1215

- **Inventory** — `project.promote` (`project`/cloud, permission
  `workspace.update`, `explicit` confirmation, `workspace_event` audit,
  `version_conflict` recovery, new `project_revision` revision kind).
- **Executor and routing** — `ManagementExecutors.promoteProjectState`,
  `ManagementOperations.projectPromote`, composition wiring, the
  `projectPromote` lead tool, and the POST route
  `.../projects/$projectId/restore.ts` (regenerated `routeTree.gen.ts`).
- **Clients** — `ApiProjectRestoreInput` + `restoreProject` in
  `@adea-ai/api-client`; `projectMutationOptions.restore` and
  `useRestoreProjectMutation` in `@adea-ai/data`.
- **Cleanup preview** — optional `MutationPlan.consequences` in
  `@adea-ai/types` (strict decoder, backward compatible when omitted), filled
  by `dev.worktree.cleanupPlan` from `buildCleanupPreview`, mapped by the Dev
  sidebar and rendered in the delete confirmation. The preview stays read-only
  (`executesNothing: true`) and never grants execution.
- **Channel archive provenance** — new `channels.archive_source`
  (`individual | project_cascade`) with the provisional migration
  `0045_solid_ted_forrester` (see migration sequencing below). The canonical
  `archiveProjectChannels`/`restoreProjectChannels` in
  `packages/db/src/project-state-policy.ts` are shared by `archiveProject`,
  `softDeleteProject` and `promoteProjectState`: the project row is locked
  first, then its channels in id order, and every versioned write is a
  compare-and-swap. Promotion wakes exactly the channels the project cascade
  slept; a channel archived independently keeps `individual` provenance and is
  never revived by a project promotion. Individual archive and primary-channel
  provisioning mark `individual`.
- **Memory** — `memory/store.ts` applies `decideMemoryPromotion` directly;
  promotion carries provenance and workspace audience unchanged and pins the
  observed revision.
- **Cleanup gates** — `cleanupSelectionBlocked` is the one destructive-step
  gate used by `commitCleanup` and the preview, so a narrowed
  non-destructive plan stays runnable on a dirty worktree. `cleanupPolicyExpiry`/
  `cleanupPolicyStanding` are the one lifetime gate: a malformed `expiresAt`
  or an unprovable clock is `invalid`, never "not expired", and every
  non-approved state authorizes nothing.

## Verification

- `bun test apps/desktop/tests/{memory-provenance,workspace-memory-store,workspace-local-data,worktree-cleanup-preview,dev-runtime-resources}.test.ts`
- `bun test packages/db/tests/unit`
- `bun --conditions=react-server test packages/db/tests/integration` (isolated
  local database) — includes the independently-archived-channel regression,
  concurrent promotion and concurrent channel restore.
- `bun test --conditions=browser apps/web/test/{management-operations,management-gateway,lead-management-tools,management-routing-boundary,project-promotion-management}.test.ts`
- `bun test packages/types/tests/{management,dev-runtime}.test.ts`
- `bunx turbo run typecheck` + `lint` over db, types, api-client, data, web,
  desktop and dev-view.
- `bun test scripts/docs-boundary.test.ts`

## Migration sequencing (root-coordinated)

- **#1233/#1213 `0045_agent-edit-revisions` lands first.** It is not merged
  yet; its ready transition awaits user confirmation under the approval
  guard. This lane neither claims nor depends on it having already landed.
- This lane's migration is provisionally numbered `0045_solid_ted_forrester`
  on the current stacked branch. Once `0045_agent-edit-revisions` actually
  lands on `main`, rebase this branch on updated `main` and **regenerate**
  the migration there: the real `packages/db/drizzle/meta/_journal.json` on
  `main` is the only authoritative numbering. Never merge two `0045`s and
  never pre-assign a replacement number from a plan.
- Planned `0046` (artifact dependency) and `0047` (requested-model selection,
  #1229) are plans until the main journal confirms them.
- Regeneration note: drizzle-kit 0.31.11 emitted only
  `ALTER TABLE ... ADD COLUMN` for the new enum used by an added column. After
  regenerating, prepend
  `CREATE TYPE "app"."channel_archive_source" AS ENUM('individual', 'project_cascade');`
  (the current file already carries it) and re-run `drizzle-kit check`.
- No migration number is claimed for publication until root confirms the
  journal state; this lane publishes only its draft PR for now.

## Follow-ups (not in this lane)

### `projects.version` replaces the `updatedAt` revision token

The promotion decision uses the exact observed `updatedAt` under a row lock
and a compare-and-swap because `projects` has no version column. When that
column lands, these are the exact hunks, and `expectedUpdatedAt` becomes
`expectedVersion` in the plan, operation and API input:

```diff
--- a/packages/db/src/schema/projects.ts
+++ b/packages/db/src/schema/projects.ts
@@
   lifecycleState: projectLifecycleState('lifecycle_state').default('active').notNull(),
+  version: integer('version').default(1).notNull(),
   visibility: projectVisibility('visibility').default('workspace').notNull(),
@@
     check('projects_sort_order_nonnegative', sql`${table.sortOrder} >= 0`),
+    check('projects_version_positive', sql`${table.version} > 0`),
```

### `dev.cleanupPolicy.createDraft` body/guard mismatch

The operation's DSL body declares `expiresAt?: timestamp`, but the shared
command decoder rejects `expiresAt` as an authority field before body
validation (`assertNoAuthorityFields`), so the field cannot be sent through
the command surface today. This predates this lane; malformed values already
stored fail closed at evaluation, and `createDraft`/`approve` validate a
directly supplied expiry. The fix belongs in the types contract (allow a
declared body field or rename it), not in the cleanup authority.
