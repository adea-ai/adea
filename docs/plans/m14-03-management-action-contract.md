# M14.03 management-action contract: #1218 scope in the combined #1230 candidate

- Status: implemented in the combined local review candidate (2026-10-12); not
  merged or live-qualified.
- Lane: **#1218** — preserve memory provenance/audience and explicit project
  state promotion; preview sensitive/dirty-worktree cleanup.
- Sibling: **#1215** — route management through shared audited APIs
  (`feat/issue-1215-management-audit-apis`, commit `8364b2865`, PR #1230).
- Consolidation: the current local #1230 candidate includes the #1215 shared
  management surface and the #1218/#1227 project, memory-provenance and cleanup
  work. No separate #1227 code commit is pending in this candidate. Remote PR
  #1227 remains an open draft and was not updated by this handoff.
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

## What the combined candidate includes from this lane

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
  (`individual | project_cascade`) in the combined candidate's migration
  `0048_graceful_prima` (see migration sequencing below). The canonical
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

- Fresh base `main` is `bc3fd1b07befaea2dc01f424423a4d0af7bcbd34`; its
  journal ends at index 47, `0047_requested_role_model_selections`. The
  earlier #1233/#1213 `0045_agent-edit-revisions`, #1207 `0046` artifact grant,
  and requested-role `0047` migrations are already in that history.
- The combined local #1230 candidate adds the actual migration
  `0048_graceful_prima` at journal index 48 (timestamp `1791602651133`) with
  its matching SQL and snapshot. It combines the previously provisional
  archive-source/project-version schema with the durable management-authority
  consumption table: `channel_archive_source` and `channels.archive_source`,
  positive `projects.version`, and `management_authority_consumptions` with its
  state enum, checks, workspace foreign key and index.
- The migration is not on `main` yet, and no migration is renumbered on `main`.
  Local `test:integration`, migration verification and `db:verify` cover the
  candidate database state; they do not establish production migration history
  or live Control Plane qualification. Verify the intended deployment target
  before any rollout.
- Remote #1227 remains an open draft that contains stacked history. Its code
  scope is represented in this local combined candidate, but this note does
  not update, close or merge that PR.

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
  `ApiProjectRestoreInput` now carry `{ confirmed: true; expectedVersion }`.
  `packages/types/src/management.ts` includes `project_revision`, the
  `project.promote` operation and the candidate's supported web/desktop/lead
  lane classifications.
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

## Implemented: dedicated policy expiry request field

`dev.cleanupPolicy.createDraft` originally declared `expiresAt?: timestamp`
in its body while the shared decoder rejects `expiresAt` as a transport
authority field before body validation, making the declared field unusable.
The fix keeps that prohibition global and renames only the policy request
field:

- `docs/specs/dev-runtime-operations.json` and the regenerated
  `packages/types/src/dev-runtime-registry.ts` declare
  `policyExpiresAt?: timestamp`; `scripts/generate-dev-runtime-contract.mjs
--check` passes.
- `apps/desktop/shell/src/dev-runtime/resources/policy.ts` reads the
  dedicated field, validates it with `cleanupPolicyExpiry` against the live
  clock, and stores the trusted record under the established `expiresAt`
  reply shape.
- No stored-record migration is required: the persisted/reply
  `CleanupPolicy`, `cleanupPolicyStanding` and every stored record are
  unchanged, and no policy with an expiry could ever be created through the
  old body field because the decoder rejected it.
- Tests through the real command surface: a valid future `policyExpiresAt`
  is accepted and stored as `expiresAt`; a well-formed non-future value
  refuses `invalid_state`; a malformed value is refused by the request
  decoder; a forged body `expiresAt` still fails with `authority field is
forbidden in body`; the parked-facts expiry regression now creates its
  policy through the surface. The stored malformed-record fail-closed
  regression stays, and `packages/types/tests/dev-runtime.test.ts` pins the
  request decoder contract.

## Follow-up (2026-10-14): gaps found after #1350 and #1359

Retention deletion stays outside this lane (#1221). What this follow-up added:

- **Memory under a prepared device cleanup** — the `memory_*` command family now
  asks the same `assertWorkspaceActive` fence as local content from inside the
  command surface (the shell wrapper keeps its own check), so the refusal is
  tested, and the Memory pane reads it as `workspace_cleanup_pending` instead
  of "could not be read".
- **Interrupted memory writes** — `memory/store.ts` removes the temp file an
  interrupted write strands (record and settings) on open and on workspace
  purge, so a crash cannot leave sealed text on disk after the workspace is
  deleted. The committed record is the truth until the rename, so a retried
  accept runs once at the revision the user saw.
- **Cleanup journal** — a `rolled_back` entry now cancels the earlier
  `completed` entry it undid. Before, a plan retried after a crash recovery
  replayed the recorded quarantine, marked a live checkout `quarantined` and
  failed later. `previewCleanupRecovery` reports `manual_recovery` for
  `recovery_required` (nothing continues it automatically).
- **Parity tests** — `cleanup-gate-parity.test.ts` drives the real worktree
  service and the real policy authority and checks that the interactive and
  automatic previews decide as the executors do, including stale plans, a policy
  revoked or expired while facts are read, and crash/retry.
- **Persona** — `agent-persona-grants.test.ts` proves against Postgres that a
  profile re-pin or presentation edit leaves audience, enlistment, sharing,
  admission and artifact-reference grants, placement and lead designation as
  stored, and that refused, stale, unauthorized and archived-Agent changes write
  nothing.

Second follow-up (same day), from review of the first:

- A retained-data-only (or any narrowed) cleanup plan used to record the live
  worktree as `cleaned`. Only a plan that quarantined the checkout changes its
  lifecycle now.
- `resumeCleanup` run again after a rollback used to flag the restored, healthy
  worktree `recovery_required`. A job whose journaled steps were all rolled back
  now reports `partial` again and changes nothing; a job that already completed is reported before any recovery mutation, so a lost response cannot flag a retained checkout.
- A refused `git worktree prune` after a quarantine now restores the checkout,
  journals the rollback (quarantine and the refused unregister step) and returns
  the record to its planned lifecycle with a new generation, so the old plan is
  `plan_stale` and a re-plan completes. When the folder cannot be restored the
  record becomes `recovery_required`, the rollback is not journaled and the
  entry stays in trash. `WorktreeServiceOptions.pruneRegistrations` is the test
  seam for this.

Third follow-up (same day), from Andrew's report that resume could claim a
deletion that never ran:

- Resuming a completed job reported every selected step `completed`. It now
  reports only what the journal proves ran: retained-data pruning (the one step
  that never journals) is `completed`, and any other selected step with no
  journal entry, such as `delete_quarantine` on a plan that never quarantined,
  is `skipped`. The commit result agrees: a selected `delete_quarantine` with
  nothing quarantined is `skipped`, not silently omitted.
- Completion now persists the exact step outcomes with the job record, and
  resume replays them, so commit and resume can never disagree. Records written
  before this change fall back to the journal. Andrew's prepared patch
  (`1370-cleanup-outcomes`) was reconciled with the journal-derived fix: the
  persisted outcomes are primary, the journal fallback is kept for legacy
  records, and commit reports a selected-but-unrun deletion as `skipped`.
