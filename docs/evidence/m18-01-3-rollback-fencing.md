# M18.01.3 — rollback readers and uncertain-effect fencing

Evidence for [#1220](https://github.com/adea-ai/adea/issues/1220), a child of
[#1181](https://github.com/adea-ai/adea/issues/1181). The parent stays open until every child and
its own acceptance criteria are satisfied. This record does not close it, and it does not claim
control-plane integration is safe (see the CP contract below).

## Delivered

- **Fence and attribution** (`fenceLeadTurnForRollback`). The fence is set once, in one `UPDATE`
  that writes the timestamp, the actor, the reason and the retained authority together. The same
  transaction locks the intent and runtime rows. A user actor must be a current workspace owner or
  admin, checked under lock. A repeat call returns the original attribution unchanged.
- **Read authority** (`withReadAuthorizedLeadTurn`, used by `readLeadTurnRollbackState`). Current
  workspace membership, current channel participation and the channel row are checked on every
  read. Archived channels stay readable to a current participant (REQ 045). Pinned execution
  authority is not compared, because archival bumps the channel version.
- **Effect authority is unchanged.** `lockAuthority` remains active-only. Prepare, dispatch,
  funding and new turns on archived channels are denied (REQ 045: archival denies new effects).
- **Effect gates** on `prepareLeadTurnRuntime`, `markLeadTurnDispatchPending` and
  `authorizeLeadTurnFundingBinding` refuse with `LEAD_TURN_FENCED`. Observation, binding recovery,
  cancellation and publication of an already-recorded result stay available so evidence can
  reconcile.
- **Pure classifier** `classifyLeadTurnRollback` with dispositions `fence_required`,
  `no_effect_recorded`, `reconcile_uncertain_effect`, `in_flight_fenced`, `terminal_retained` and
  `blocked_unclassifiable`. Unknown or inconsistent evidence fails closed.

## Schema (for root ordering)

Migration file: `packages/db/drizzle/0047_lead_turn_rollback_fence.sql`. It is local to
`feat/issue-1220-rollback-fencing` and is **not** renumbered. It collides with the reserved 0047
and the stacked 0048–0051, so root orders it. Its only dependency is the base schema at 0046
(`lead_turn_intents` from 0043). Nothing else in the migration touches other tables.

On `app.lead_turn_intents`, all new columns are nullable with no default:

| Column                      | Type          | Constraint                                                                                     |
| --------------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `rollback_fenced_at`        | `timestamptz` | set once by the fence                                                                          |
| `rollback_fence_actor_kind` | `text`        | `user` or `operator` (`lead_turn_intents_rollback_fence_actor_valid`)                          |
| `rollback_fence_actor_ref`  | `text`        | user UUID or operator id (same check)                                                          |
| `rollback_fence_reason`     | `text`        | `operator_intervention` or `rollback_cohort` (`lead_turn_intents_rollback_fence_reason_valid`) |
| `rollback_fence_authority`  | `jsonb`       | object with `schemaVersion = 1` (`lead_turn_intents_rollback_fence_authority_valid`)           |

- `lead_turn_intents_rollback_fence_complete` (CHECK): the five columns are all null or all set,
  so a partial fence cannot commit.
- `app.lead_turn_intents_rollback_fence_immutable()` with trigger
  `lead_turn_intents_rollback_fence_immutable` (BEFORE UPDATE): once set, none of the five columns
  can change or be cleared. Unrelated updates still pass. This is hand-written SQL appended to the
  migration, following the plpgsql precedent in `0033`. drizzle does not model triggers.
- No index. No other table is changed. Writes go only through `fenceLeadTurnForRollback`.

Replacing the earlier local 0047 (single column) with this content is a non-force commit. No shared
database has applied the earlier version.

## Acceptance coverage

| Test    | Scope in this leaf                                                                                                                                                                                                                                           | Result                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| A31     | Prepared fence blocks dispatch; uncertain dispatch keeps evidence and reconciles; in-flight attempt can be cancelled and observed; completed attempt keeps one publication; repeat fence is idempotent; outsider and foreign workspace learn nothing         | Covered, integration          |
| A30     | Authorized archived history is observable to a current participant, with fence attribution. A removed participant, a removed membership and an outsider are denied. Archival denies `prepare`, `dispatch`, funding and new turns.                            | Covered, integration          |
| A01     | Rollback reads and fencing keep exactly one workspace lead and every custom Agent                                                                                                                                                                            | Covered, integration          |
| A02     | Retried admission after the fence returns the original intent; topics with one Agent stay distinct                                                                                                                                                           | Covered, integration          |
| A36     | Pre-fence projection unchanged by the fence; all new columns nullable with no default; rollback module imports no content, remote, sync or replica code                                                                                                      | Covered, integration and unit |
| REQ 154 | Attribution written atomically; first attribution kept; plain member refused (`ROLLBACK_FENCE_FORBIDDEN`); outsider sees `unavailable`; operator id validated before any write; DB rejects partial or malformed attribution; attribution immutable at the DB | Covered, integration and unit |

## Attribution contract (REQ 154)

`fenceLeadTurnForRollback(database, workspaceId, intentId, { actor, reason })` returns
`{ intentId, disposition, fenced, alreadyFenced, attribution? }`. `attribution` is:

- `fencedAt`: ISO time of the fence write.
- `actor`: `{ kind: 'user', userId }` or `{ kind: 'operator', operatorId }`.
- `reason`: `rollback_cohort` or `operator_intervention`.
- `authority`: `schemaVersion: 1`, `workspaceId`, `actorMembershipId`, `actorRole` (`owner` or
  `admin` for users, `null` for operators), `channelId`, `channelVersion`,
  `channelLifecycleState`, `runtimeState` (`null` if no runtime row), and the `disposition` at fence
  time.

A terminal admission is not written. It returns `fenced: false` with its classification.

## Known gaps and decisions for root

- **Existing readers still fail closed on archived channels.** Only the rollback reader uses the
  read path. `getLeadTurnForUser`, `readLeadTurnRuntime` and `getLatestLeadTurnForChannel` still use
  the active-only gate. Migrating them is a separate decision.
- **Runtime observation on archived admissions remains denied.** `observeLeadTurnRuntime` shares the
  effect gate. It writes evidence rather than creating an effect, so it is a candidate for the read
  path. That would let an archived uncertain effect be reconciled. The decision is yours.
- **Operator attribution is by reference.** The `operator` kind is trusted in-process only. There is
  no operator identity system here.

## CP contract (control-plane #940 / #942): not integration-safe yet

The control plane owns its own persistence. It cannot read Adea's `lead_turn_intents` table, so it
needs a fence signal from Adea. The following must exist before a rollback can rely on this fence.
None of it is implemented here.

1. **Fence notice from Adea to CP.** Key: the dispatch key `lead-turn:<intentId>`, plus the
   `executionId` and `attemptId` from `lead_turn_runtime`. Payload: the fence attribution above.
   CP must persist it durably and acknowledge it.
2. **Enforcement at every CP claim.** CP must check its stored fence in the same transaction that
   claims a dispatch, resume or restart for that admission. A fenced claim is refused. This covers
   every current CP reader and dispatcher that can create or resume an attempt.
3. **Lock order.** The CP claim must not hold the attempt lock while waiting on the admission. Adea
   locks the intent before the runtime row, so the CP side must follow the same ordering for any
   shared row.
4. **Disposition actions** (from `classifyLeadTurnRollback`):
   - `fence_required`: do not route. Fence first.
   - `no_effect_recorded`: may admit under a **new** CP attempt on the previous path. Never reuse the
     Adea `attemptId`.
   - `reconcile_uncertain_effect`: never re-dispatch. Reconcile by dispatch or effect identity (REQ 102) before any resume.
   - `in_flight_fenced`: runtime-owned. Observe only.
   - `terminal_retained`: history. Nothing resumes.
   - `blocked_unclassifiable`: stop and refer to operator review.
5. **Error codes the CP path must mirror:** `LEAD_TURN_FENCED` (new effect refused),
   `ROLLBACK_FENCE_FORBIDDEN`, `INVALID_ROLLBACK_FENCE_REQUEST`, `LEAD_TURN_FENCE_EVIDENCE_INVALID`.

Until items 1 and 2 are implemented and tested in the CP repo, the rollback window is **not safe**.
Pre-fence code ignores the fence.

## Cross-repo and open dependencies

- control-plane [#940](https://github.com/adea-ai/control-plane/issues/940) (L3) and
  [#942](https://github.com/adea-ai/control-plane/issues/942) (P2): owners of the CP contract above.
- control-plane [#186](https://github.com/adea-ai/control-plane/issues/186) (reuse gate): not
  checked here.
- Adea [#1175](https://github.com/adea-ai/adea/issues/1175) and
  [#1180](https://github.com/adea-ai/adea/issues/1180): open upstream dependencies. #1174 is closed.

## Validation

Run on `feat/issue-1220-rollback-fencing` against a local Postgres 16 container, migrations
0001–0047 applied, `db:verify` passed (48 applied migrations).

- Focused lead-turn suites (`lead-turns`, `lead-turn-runtime`, `lead-topic-migration`,
  `workspace-leads`, `lead-turn-rollback`): 34 pass, 0 fail.
- `packages/db` unit (`lead-turn-rollback`): 13 pass, 0 fail.
- Full `packages/db` integration, 60 s per-test timeout: 221 pass, 11 skip, 1 fail. The failure is
  `task-submissions` "operator entry refuses a wrong target". It also fails on clean `origin/main`
  in this environment, so it predates this change.
- Root `test:coverage`: 537 tests, 1 fail. The failure is `stylesheet-usage-boundary` hitting the
  5 s default timeout. It passes with a 60 s timeout (3/3). This is timing, not a regression.
- Root `format:check`: exit 0. Root `oxlint --deny-warnings`: exit 0. `packages/db` typecheck: exit 0.
- Not run: Playwright E2E, packaged and desktop suites, performance, soak, and root `build`.
