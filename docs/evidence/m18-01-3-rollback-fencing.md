# M18.01.3 — rollback readers and uncertain-effect fencing

Evidence for [#1220](https://github.com/adea-ai/adea/issues/1220), a child of
[#1181](https://github.com/adea-ai/adea/issues/1181). The parent stays open until every child and
its own acceptance criteria are satisfied. This record does not close it.

## Delivered

- `lead_turn_intents.rollback_fenced_at` (migration `0047_lead_turn_rollback_fence`): one
  nullable, additive timestamp. Pre-fence writers and readers are unaffected, and the column is
  never cleared once set.
- `packages/db/src/lead-turn-rollback.ts`:
  - `classifyLeadTurnRollback` is a pure classifier over retained evidence. Its dispositions are
    `fence_required`, `no_effect_recorded`, `reconcile_uncertain_effect`, `in_flight_fenced`,
    `terminal_retained` and `blocked_unclassifiable`. Anything that does not match a known shape
    fails closed.
  - `fenceLeadTurnForRollback` is the trusted rollback boundary. It sets the fence once, is
    idempotent, does not write terminal admissions, and never rewrites state, dispatch identity,
    runtime session or publication evidence.
  - `readLeadTurnRollbackState` is the rollback reader. It uses the same live authority as the
    other lead-turn readers, so denied users get the same unavailable answer.
- Gates on new effects in `lead-turn-runtime.ts`: `prepareLeadTurnRuntime`,
  `markLeadTurnDispatchPending` and the funding check refuse with `LEAD_TURN_FENCED`. Observation,
  binding recovery, cancellation and publication of an already-recorded result remain available
  because they reconcile evidence rather than create a new effect. Intent and runtime locks are
  taken in the same order as the fence.

## Not delivered (deliberate)

- No checkpoint conversion (REQ 173). No LangGraph state is transplanted.
- No change to cross-device history sync or [#193](https://github.com/adea-ai/adea/issues/193).
- No resume or restart of a fenced admission. Each admission has one runtime attempt, so a fence is
  final for that attempt. A new attempt needs control-plane work.

## Acceptance coverage

| Test | Scope in this leaf                                                                                                                                                                                                                                                                        | Result                                                                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A31  | Prepared fence blocks dispatch; uncertain dispatch keeps evidence, reconciles by binding and cannot be redispatched; in-flight attempt can be cancelled and observed; completed attempt keeps one publication; repeated fence is idempotent; outsider and foreign workspace learn nothing | Covered, integration                                                                                                                                                                                          |
| A01  | Rollback reads and fencing keep exactly one workspace lead and every custom Agent                                                                                                                                                                                                         | Covered, integration                                                                                                                                                                                          |
| A02  | Retried admission after fence returns the original intent; topics with one Agent stay distinct                                                                                                                                                                                            | Covered, integration                                                                                                                                                                                          |
| A30  | Archived admission keeps its record and fence and fails closed for every reader                                                                                                                                                                                                           | **Partial.** Reading archived history is not provided. Lead-turn authority admits only active channels, so the actor is denied too. REQ 045 says archive preserves history, so this needs a product decision. |
| A36  | Pre-fence projection is unchanged by the fence; new column is nullable; rollback module imports no content, remote, sync or replica code                                                                                                                                                  | Covered, integration and unit                                                                                                                                                                                 |

## Cross-repo and open dependencies (not available here)

- control-plane [#940](https://github.com/adea-ai/control-plane/issues/940) (L3) and
  [#942](https://github.com/adea-ai/control-plane/issues/942) (P2): the legacy and Pi routing path
  must honour `rollback_fenced_at`. Pre-fence code ignores the column, so the rollback window is
  not safe until that path refuses fenced admissions.
- control-plane [#186](https://github.com/adea-ai/control-plane/issues/186) (reuse gate): not
  checked here.
- Adea [#1175](https://github.com/adea-ai/adea/issues/1175) and
  [#1180](https://github.com/adea-ai/adea/issues/1180): open upstream dependencies. #1174 is closed.
- Operator attribution of each fence (REQ 154) is not recorded. It needs a follow-up.

## Validation

- `packages/db` unit: 226 pass, 0 fail (10 new in `tests/unit/lead-turn-rollback.test.ts`).
- `packages/db` integration on local Postgres 16 (Docker), migrations 0001–0047 applied,
  `db:verify` passed (48 applied): 215 pass, 11 skip, 1 fail with a 60-second per-test timeout. The
  failing test is `task-submissions` "operator entry refuses a wrong target". It fails the same way
  on clean `origin/main` in this environment, so it is not caused by this change. Ten new tests in
  `tests/integration/lead-turn-rollback.test.ts` pass.
- Root `test:coverage`: 534 pass, 0 fail.
- Monorepo `typecheck`: 31 of 31 successful.
- `db:check`: clean.
- Root `format:check`: clean. `packages/db` lint: clean.
- Not run: Playwright E2E, packaged and desktop suites, performance, soak, and root `build`.
