# M11.01.1 workspace lead identity and revision-safe Agent edits

Recorded 2026-10-09 for [Adea #1213](https://github.com/adea-ai/adea/issues/1213) on branch
`feat/issue-1213-stable-lead`, head `17a0efdfc` plus the evidence commit, against Node 24.21.0,
Bun 1.4.0, Playwright 1.63.0 and an isolated disposable PostgreSQL 18.

## What this issue owns

Exactly one lead per workspace, custom Agent identity and attribution, revision-safe edits, and
migration evidence that original audiences, histories and ownership survive. [PRs #1186 and
#1190](../specs/workspace-events.md) are the structural groundwork this slice reuses: the
`agents_workspace_lead_unique` partial index, the lead standalone check, the workspace-serialized
`ensureWorkspaceLead`, the lead API and the profile-pin revision flow all predate this work and are
untouched. The global directory (#1174), handoff (#1177), group runtime (#1178), model setup
(#1211), management APIs (#1215), artifact grants (#1216), cleanup/provenance (#1218) and snapshot
capture (#1219) remain their owners' scope; nothing here edits their surfaces.

## What changed

Migration `0045_agent-edit-revisions.sql` adds `agents.revision` (integer, default 0, nonnegative
check) beside the existing `agents.profile_revision`. Presentation and placement edits now carry the
revision they opened; the database locks the active Agent row, refuses any other revision with
`AgentRevisionConflictError` without writing, and advances `revision` in the same transaction as the
change. The API maps that to `AGENT_REVISION_CONFLICT` (409), the client sends `expectedRevision`,
and the shell chains the revision each accepted step returns, so a placement edit opens from the
presentation response rather than from a stale snapshot. Profile pins keep their own counter: a
rename never invalidates a pin and a re-pin never invalidates a placement opening. The
`agent.presentation_updated` and `agent.project_assigned` payloads are unchanged.

Archive stays a lifecycle transition rather than a revision-checked edit; a designated lead still
cannot be archived or placed under a Project, and `agents_workspace_lead_unique` still rejects a
second designation written through any path.

## Acceptance map

| Issue clause                                                       | Where it is implemented and pinned                                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exactly one same-workspace lead; cross-workspace independence      | `workspace-leads.test.ts`: one lead per workspace under concurrent provisioning, per-workspace lookup, direct `is_workspace_lead = true` write refused by `agents_workspace_lead_unique`, foreign lead invisible through `getAgentForUser`.            |
| Custom Agent identity, stable IDs, attribution preserved           | `workspace-leads.test.ts` compares the custom Agent row byte-for-byte across lead provisioning, rename and pin adoption, asserts distinct Control Plane IDs, and checks both `agent.created` events carry the provisioning actor.                      |
| Revision-safe edits, stale conflicts without lost updates          | `agent-edit-revisions.test.ts`: one winner per concurrent opening, stale presentation and placement refusals with no event written, malformed revisions refused, profile and presentation counters independent, lead rename conflict-safe.             |
| Partial and mounted save behaviour                                 | `apps/web/e2e/agent-edit-revision.spec.ts` drives the real shell, controller, client, roster and form in a browser: stale conflict stops the save, a partial multi-step save keeps its completed step, and a refetch resumes from the server revision. |
| Migration evidence that audiences, histories and ownership survive | `lead-identity-migration.test.ts` (below) applies the reviewed 0042 and 0045 SQL to realistic old-shape fixtures and requires every pre-existing column to be unchanged.                                                                               |

## Migration evidence: what it is and what it is not

`packages/db/tests/integration/lead-identity-migration.test.ts` builds **session-local table copies**
in `pg_temp` (`CREATE TEMPORARY TABLE … (LIKE app.<table> INCLUDING DEFAULTS INCLUDING IDENTITY)`)
for `workspaces`, `workspace_memberships`, `agents`, `channels`, `channel_participants`,
`messages`, `message_mentions`, `channel_read_states`, `thread_read_states` and `workspace_events`.
It drops the columns the migrations add, recreates the pre-0042 direct-lane index, seeds a realistic
two-workspace fixture, then applies the reviewed migration SQL verbatim with the `"app"` schema
rewritten to `"pg_temp"` and compares `to_jsonb(t)` for every table before and after.

The fixture is deliberate, not default data: four Agents across `active`, `archived` and
`configuration_error` states, one project-assigned with a pinned profile at revision 3, seven
channels including an archived legacy direct lane, a reopened lane under the legacy key, a
participant-only group and a second workspace's lane, ten participants (user and Agent principals),
thirteen messages including an Agent-authored history, a threaded reply, an edited message and a
tombstone, mentions, channel and thread read frontiers, five memberships with owner/admin/member
roles, and six attribution events carrying `actor_id`.

**This is not a full production-schema upgrade proof.** The copies are session-local: foreign keys,
indexes that were not recreated, and constraints outside the two migrations are not part of the
fixture, no production database or inventory is touched, and no claim is made about a live
backfill. The proof is scoped to the two migrations under review — that applying them to old-shape
data changes no pre-existing column of audiences, histories or ownership, and that the resulting
shape enforces lead uniqueness, the standalone lead check, the nonnegative edit revision and
legacy default-lane vs topic lane semantics. The full-chain upgrade, deterministic-rerun evidence
comes from `db:verify` against a real database (46 applied migrations, deterministic rerun below),
and a production migration remains its own reviewed step.

Sensitivity was checked by mutating the reviewed SQL and the guard rather than trusting a green
run: appending a data-altering `UPDATE` to 0045 failed the preservation assertion on the archived
Agent's name, and disabling the revision comparison failed four of five revision tests. Both
mutations were reverted byte-for-byte (`cmp` against the backup) before this record was written.

## Migration numbering: 0045 collision and resolution plan

`origin/main` ends at `0044_lead_turn_runtime`. Three open lanes currently carry a file named
`0045_*.sql` with three different journal tags:

| Lane                                 | 0045 file                                  |
| ------------------------------------ | ------------------------------------------ |
| `feat/issue-1213-stable-lead` (this) | `0045_agent-edit-revisions.sql`            |
| `feat/artifact-grant-store-1180`     | `0045_artifact_reference_grants.sql`       |
| `feat/pi-requested-role-selection`   | `0045_requested_role_model_selections.sql` |

A drizzle journal must be strictly increasing by `idx`, and `_journal.json` is per-branch: the
conflict only materialises when two of these branches merge. **No renumbering has been done in this
branch**, and it holds exactly one `idx: 45` entry (no duplicate journal entries). Renumbering
unilaterally would just move the collision to whatever number another lane picks next, so the
resolution is coordinated:

1. The first of the three lanes to merge into `main` keeps `0045`.
2. Each remaining lane rebases onto the updated `main` and **regenerates** its migration with
   `bun run --cwd packages/db db:generate -- --name=<short-name>` so drizzle assigns the next free
   index, updates `prevId` on the new snapshot, and deletes its own stale `0045_*` SQL, snapshot and
   journal entry in the same change. Never hand-edit two lanes onto one index.
3. After the rebase: `db:check` must be clean, `db:verify` must report a deterministic rerun, and
   the journal must contain each index exactly once.
4. Schema/export coordination: `AgentSummary.revision` in `@adea-ai/types`, the
   `ApiAgentPresentationInput.expectedRevision` and `ApiAgentProjectInput` shapes in
   `@adea-ai/api-client`, and the `assignAgentToProject` signature in `@adea-ai/db` are additive and
   issue-scoped, but they are shared-package changes; the lanes above touch the same packages, so
   whoever rebases second resolves the ordinary textual conflicts in the same pass as the
   renumbering.

## Validation

Every command below was run in this session against an isolated disposable PostgreSQL 18 (compose
project `adea-1213-pg`, strict port 55433) so no other lane's database or container was used.

| Command                                                                                           | Result                                                                                   |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `bun run format:check`                                                                            | exit 0, 1981 files                                                                       |
| `bun run lint`                                                                                    | exit 0, 17 lint tasks, zero warnings/errors                                              |
| `bun run typecheck`                                                                               | exit 0, 31/31 tasks                                                                      |
| `bun run build`                                                                                   | exit 0, 15/15 tasks                                                                      |
| `bun run --cwd packages/db db:check`                                                              | exit 0, `Everything's fine`                                                              |
| `bun run --cwd packages/db db:verify`                                                             | exit 0, `Migration verification passed (46 applied migration(s))`, deterministic rerun   |
| focused DB integration (5 files)                                                                  | exit 0, 15 pass / 0 fail, 113 assertions                                                 |
| focused API/client/UI (3 files)                                                                   | exit 0, 9 pass / 0 fail                                                                  |
| `bun run test:integration`                                                                        | exit 0, 195 pass / 0 fail, 2483 assertions, 38 files                                     |
| `bun run test:unit`                                                                               | exit 0, 30 turbo tasks; coverage lane 448 pass / 0 fail, 68.69% lines / 85.80% functions |
| `bunx playwright test … apps/web/e2e/agent-edit-revision.spec.ts`                                 | exit 0, 3 passed (stale conflict, partial multi-step save, refetch resume)               |
| `bunx playwright test … apps/web/e2e/conventional-workspace.spec.ts --grep "customizes an Agent"` | exit 0, 1 passed, 36.3s                                                                  |
| `bun run --cwd apps/web start:check-bundle`                                                       | exit 0, production client budget unchanged                                               |
| `bun scripts/docs-boundary.test.ts`                                                               | exit 0, docs links and spec router clean                                                 |
| `code-foundry doctor`                                                                             | exit 0, `Repository doctor passed`                                                       |

The mounted E2E ran against a real Vite dev server on strict port 3101 pointed at the same
disposable database (`PERF_BASE_URL=http://127.0.0.1:3101`); Playwright's own `webServer` was
disabled so no shared port was reused. The spec is registered in `scripts/e2e-playwright.mjs`, so
the CI E2E shards run it.

### Bundle failure is pre-existing, verified not inferred

`bun run test:bundle:dev-view` fails on this branch:

```
Error: Dev View entry src-DLKQiZhh.js (201485 bytes) plus layout renderer
layout-view-CnUJWL5_.js (14245 bytes) totals 215730 bytes; budget is 114688 bytes
```

The same command was run against a **pristine `origin/main` worktree** (detached at `413aa9735`,
fresh `bun install --frozen-lockfile`, `bun run build` exit 0 first so the guard measured a real
build):

```
Error: Dev View entry src-Dk2eZfyw.js (201485 bytes) plus layout renderer
layout-view-Bvhw_mji.js (14245 bytes) totals 215730 bytes; budget is 114688 bytes
```

Both runs fail with the identical aggregate `215730` against the identical `114688` budget; only the
content-hash file names differ. The Dev View entry and layout renderer that this guard measures are
byte-identical between the baseline and this branch, so the failure pre-exists `main` and this
change does not move it. The production client budget gate (`start:check-bundle`) passes on this
branch. This remains a pre-existing Dev View performance follow-up; no cap or test was changed.

## Rollout and rollback

Apply 0045 before any caller that sends `expectedRevision`. Until every writer checks the revision,
a pre-0045 writer can edit without advancing it, so complete the rollout before relying on
conflicts. The column is additive with default 0, so rollback is forward-only in the usual way: the
application tolerates the column, and no data is rewritten by the migration.

## Boundaries

No production migration, deployment, credential, provider or model inference was performed. No
other issue's scope was edited. Fixes and this record were produced in the same preserved session
under the authorized model switch; the earlier worker's patch and initial timings remain credited as
documented in the session handoff. Acceptance closure belongs to root's review.
