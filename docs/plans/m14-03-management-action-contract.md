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

- **#1233/#1213 `0045_agent-edit-revisions` has landed.** Verified on actual
  `main` = `30913129c` (squash of reviewed `fdc940d79`); the main journal ends
  `idx 45 = 0045_agent-edit-revisions`. Nothing here claims or fabricates that
  landing.
- This branch is still stacked on the pre-#1233 #1215 commit and therefore
  carries **two provisional, branch-local migrations**: `0045_solid_ted_forrester`
  (channels `archive_source`) and `0046_wealthy_mister_fear`
  (`projects.version` + positive check). They exist only so the branch can be
  tested; they are not for publication and must not be merged as numbered.
- At the safe integration point (after 1207 regenerates `0046` and #1229's
  `0047` land), rebase on actual `main`, delete both provisional SQL/snapshot
  entries, and regenerate **one** combined migration from the authoritative
  journal; the number is coordinated with root, never pre-assigned.
- Regeneration note: drizzle-kit 0.31.11 emitted only
  `ALTER TABLE ... ADD COLUMN` for the new enum used by an added column. After
  regenerating, prepend
  `CREATE TYPE "app"."channel_archive_source" AS ENUM('individual', 'project_cascade');`
  and re-run `drizzle-kit check`.
- No migration number is claimed for publication until root confirms the
  journal state; this lane publishes only its draft PR.

## Implemented: canonical project revision

ROOT authorized this slice. The timestamp authority is fully replaced:

- `packages/db/src/schema/projects.ts`: additive `version integer DEFAULT 1
NOT NULL` with `CHECK (version > 0)`, matching the workspaces/channels
  convention.
- `packages/types/src/index.ts`: `ProjectSummary.version: number`.
- `packages/db/src/project-summary.ts`: the one canonical `projectSummary(row)`
  mapper, exported from the db barrel and used by `projects.ts`,
  `project-sharing.ts` and `project-state-policy.ts` (duplicated mappers
  removed).
- Every project-row mutation increments atomically: `updateProject`,
  `archiveProject`, `softDeleteProject`, `reorderProjects` (included),
  `setProjectVisibility` and `promoteProjectState`. `createProject` starts
  at 1. Membership rows keep their own operation contracts and are not part
  of the project-row revision.
- `decideProjectStatePromotion` and `promoteProjectState` take
  `expectedVersion: number`; a non-safe-integer, `< 1` or mismatched revision
  refuses `promotion_stale`, and the SQL CAS is
  `eq(projects.version, expectedVersion)`. Timestamps remain display-only.
- The management executor/operation, the `restore` route and
  `ApiProjectRestoreInput` now carry `{ confirmed: true; expectedVersion }`;
  `packages/types/src/management.ts` was not edited — `project_revision`
  remains the catalog name for this integer.
- Archived-channel provenance and the project→channels(id) lock order are
  unchanged.

Permanent regressions:

- `packages/db/tests/unit/project-state-policy.test.ts`: version-token cases
  including zero/negative/fractional/NaN/non-number revisions.
- `packages/db/tests/integration/project-state-promotion.test.ts`:
  microsecond timestamps no longer block an exact revision; a
  same-millisecond edit still moves the token and refuses the old revision.
- `packages/db/tests/integration/projects.test.ts`: every row mutation
  increments the revision (update → visibility → reorder → archive → soft
  delete), and the summary key set includes `version`.

## Follow-up (not in this lane)

### `dev.cleanupPolicy.createDraft` body/guard mismatch

The operation's DSL body declares `expiresAt?: timestamp`, but the shared
command decoder rejects `expiresAt` as an authority field before body
validation (`assertNoAuthorityFields`), so the field cannot be sent through
the command surface today. This predates this lane; malformed values already
stored fail closed at evaluation, and `createDraft`/`approve` validate a
directly supplied expiry. The fix belongs in the types contract (allow a
declared body field or rename it), not in the cleanup authority.
