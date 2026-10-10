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
- **Historical boundary** (`withHistoricalLeadTurn`, `lead-turns.ts`). Existing admissions are
  observed, reconciled and cancelled through it. Current workspace membership, current channel
  participation and the channel row are checked on every call. For an archived channel the pinned
  execution comparison is replaced by those live checks, because archival bumps the channel version.
  An active channel keeps the full pinned `lockAuthority` path unchanged.
- **Canonical readers now use the historical boundary:** `readLeadTurnRuntime`,
  `getLeadTurnForUser`, `getLatestLeadTurnForChannel`, `observeLeadTurnRuntime`,
  `recoverLeadTurnRuntimeBinding`, `requestLeadTurnCancellation` (actor only, with the same
  `runtime.invoke` and audience checks as an active cancel), `readLeadTurnRollbackState`, and
  `resolveLeadTurnAuthority` with purpose `read` or `cancel`.
- **App runtime purposes** (`apps/web` `LeadRuntimeStore.authorize`): `status`, `progress`, the
  binding-recovery recheck and the snapshot request `read`. `cancel` requests `cancel`. `prepare` and
  `dispatch` request `effect`.
- **Effect authority is unchanged and active-only:** `createLeadTurn`, `prepareLeadTurnRuntime`,
  `markLeadTurnDispatchPending`, `authorizeLeadTurnFundingBinding`, `publishLeadTurnResult` (it
  appends a new Message), and the product reader that feeds CP dispatch.
- **Effect gates** on `prepare`, `dispatch` and funding refuse fenced admissions with
  `LEAD_TURN_FENCED`.
- **Pure classifier** `classifyLeadTurnRollback` with dispositions `fence_required`,
  `no_effect_recorded`, `reconcile_uncertain_effect`, `in_flight_fenced`, `terminal_retained` and
  `blocked_unclassifiable`. Unknown or inconsistent evidence fails closed.

## Authority purposes

| Purpose                                                         | Who                                                        | Archived channel  | Fenced admission                                           |
| --------------------------------------------------------------- | ---------------------------------------------------------- | ----------------- | ---------------------------------------------------------- |
| read / observe / recover                                        | current workspace member and current user participant      | allowed (REQ 045) | allowed (reconcile)                                        |
| cancel                                                          | original actor, plus `runtime.invoke` and audience members | allowed (REQ 045) | allowed (reconcile)                                        |
| effect (prepare, dispatch, funding, new turn, publish, product) | original actor, active channel, pinned                     | denied            | denied for prepare, dispatch, funding; product not emitted |

Redispatch is denied by every path: archived or fenced, `prepare` and `markDispatchPending` refuse.

## Schema (for root ordering)

Migration file: `packages/db/drizzle/0047_lead_turn_rollback_fence.sql`. It is local to
`feat/issue-1220-rollback-fencing` and is **not** renumbered. It overlaps the reserved 0047 and the
role-selection stack, so root orders it. Its only dependency is the base schema at 0046
(`lead_turn_intents` from 0043). No other table is changed.

On `app.lead_turn_intents`, all new columns are nullable with no default:

| Column                      | Type          | Constraint                                                                                     |
| --------------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `rollback_fenced_at`        | `timestamptz` | set once by the fence                                                                          |
| `rollback_fence_actor_kind` | `text`        | `user` or `operator` (`lead_turn_intents_rollback_fence_actor_valid`)                          |
| `rollback_fence_actor_ref`  | `text`        | user UUID or operator id (same check)                                                          |
| `rollback_fence_reason`     | `text`        | `operator_intervention` or `rollback_cohort` (`lead_turn_intents_rollback_fence_reason_valid`) |
| `rollback_fence_authority`  | `jsonb`       | object with `schemaVersion = 1` (`lead_turn_intents_rollback_fence_authority_valid`)           |

- `lead_turn_intents_rollback_fence_complete` (CHECK): the five columns are all null or all set, so a
  partial fence cannot commit.
- `app.lead_turn_intents_rollback_fence_immutable()` with trigger
  `lead_turn_intents_rollback_fence_immutable` (BEFORE UPDATE): once set, none of the five columns can
  change or be cleared. Unrelated updates still pass. This is hand-written SQL appended to the
  migration, following the plpgsql precedent in `0033`. drizzle does not model triggers.
- No index. Writes go only through `fenceLeadTurnForRollback`.

## Emitted field contract (signed current product reader)

The only CP-facing seam is the existing signed route `POST /api/internal/pi-durable/lead-product/current`
(`apps/web/src/server/lead-product-reader-route.ts`). Its authentication is unchanged. There is no
new notice, attestation or endpoint.

**Unfenced admission.** The v1 shape is unchanged. Fields: `schemaVersion: "pi-lead-intent/v1"`,
`intentId`, `workspaceId`, `projectId`, `messageRef`, `authorityRevision`, `principalRef`,
`canonicalActorPrincipalId`, `scopeRef`, `expiresAt`, `allowedPrincipalIds`, `prompt`, `profileId`,
`profileVersion`, `profileRevision`. No fence field is added, so existing parsers see no change.

**Fenced admission.** The response is fence-only. It carries no prompt, profile, scope, principal or
allowed-principal list, so no dispatch can be built from it.

```json
{
  "schemaVersion": "pi-lead-intent-fence/v1",
  "intentId": "<uuid>",
  "workspaceId": "wsp_<26-char>",
  "dispatchPermitted": false,
  "rollbackFence": {
    "fencedAt": "<ISO-8601>",
    "reason": "rollback_cohort | operator_intervention",
    "actor": { "kind": "user", "userId": "<uuid>" }
  }
}
```

`rollbackFence.actor` is `{ "kind": "operator", "operatorId": "<id>" }` for operator fences. The
response has `cache-control: private, no-store` and returns HTTP 200.

**Archived or unauthorized admission.** HTTP 404 `{ "code": "LEAD_PRODUCT_UNAVAILABLE" }`. A 404
does not mean "not fenced". CP must treat it as "no dispatchable product", and must not infer a fence
state from it.

**Who may read.** The reader still requires the signed service proof and the original actor. Current
membership and participation are checked on each read. Retained authority (membership and channel
detail) stays inside Adea and is never emitted.

## Acceptance coverage

| Test    | Scope in this leaf                                                                                                                                                                                                                                                                                                                                                 | Result                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| A31     | Prepared fence blocks dispatch; uncertain dispatch keeps evidence and reconciles by binding and observation without redispatch; in-flight attempt can be cancelled by the actor; completed attempt keeps one publication; repeat fence is idempotent; outsider and foreign workspace learn nothing                                                                 | Covered, integration                   |
| A30     | Archived uncertain dispatch is readable through every canonical read API by a current participant. Archived observation, binding recovery and cancellation work for participants. Removed participant, removed membership, outsider and non-actor cancel are denied. Archival denies `prepare`, `dispatch`, funding, new turns, publication and the product reader | Covered, integration                   |
| A01     | Rollback reads and fencing keep exactly one workspace lead and every custom Agent                                                                                                                                                                                                                                                                                  | Covered, integration                   |
| A02     | Retried admission after the fence returns the original intent; topics with one Agent stay distinct                                                                                                                                                                                                                                                                 | Covered, integration                   |
| A36     | Pre-fence projection unchanged by the fence; all new columns nullable with no default; rollback module imports no content, remote, sync or replica code                                                                                                                                                                                                            | Covered, integration and unit          |
| REQ 154 | Attribution written atomically; first attribution kept; plain member refused (`ROLLBACK_FENCE_FORBIDDEN`); outsider sees `unavailable`; operator id validated before any write; DB rejects partial, malformed and rewritten attribution                                                                                                                            | Covered, integration and unit          |
| Product | Fenced admission returns fence-only body with no dispatch fields; unfenced body unchanged; operator fence emitted by reference; archived admission not emitted                                                                                                                                                                                                     | Covered, integration (db) and app test |
| Purpose | Prepare and dispatch request `effect`; status, progress and recovery request `read`; cancel requests `cancel`, never `effect`                                                                                                                                                                                                                                      | Covered, app test                      |

## Attribution contract (REQ 154)

`fenceLeadTurnForRollback(database, workspaceId, intentId, { actor, reason })` returns
`{ intentId, disposition, fenced, alreadyFenced, attribution? }`. `attribution` is:

- `fencedAt`: ISO time of the fence write.
- `actor`: `{ kind: 'user', userId }` or `{ kind: 'operator', operatorId }`.
- `reason`: `rollback_cohort` or `operator_intervention`.
- `authority`: `schemaVersion: 1`, `workspaceId`, `actorMembershipId`, `actorRole` (`owner` or
  `admin` for users, `null` for operators), `channelId`, `channelVersion`, `channelLifecycleState`,
  `runtimeState` (`null` if no runtime row), and the `disposition` at fence time.

A terminal admission is not written. It returns `fenced: false` with its classification.

## Known gaps and decisions for root

- **Publication on archived admissions is denied.** A completed result on an archived channel stays
  unpublished, because publication appends a new Message (REQ 045: archival denies new effects).
  Your call whether that should change.
- **Pinned audience drift on active admissions.** The pinned comparison is unchanged, so a participant
  added after admission makes an active observation fail with `Lead turn version conflict`. Archived
  reads are not affected.
- **Operator attribution is by reference.** The `operator` kind is trusted in-process only. There is
  no operator identity system here.
- **No CP-facing reconciliation route.** Observation, binding recovery and cancellation are Adea
  app-side calls. CP has no endpoint to reconcile an archived or fenced uncertain effect yet.

## CP contract (control-plane #940 / #942): not integration-safe yet

The control plane owns its own persistence. It cannot read Adea's `lead_turn_intents` table, so it
needs the fence through the existing signed reader above. This is the only seam. The following
remain pending in the CP repo and are not implemented here.

1. **Refuse on the fenced shape.** CP must treat `schemaVersion: pi-lead-intent-fence/v1` as a
   refusal to dispatch and must not parse it as an admission. An unknown schema also means refuse.
2. **Enforce at every CP claim.** CP must check its own stored fence in the same transaction that
   claims a dispatch, resume or restart for that admission. A fenced claim is refused. This covers
   every current CP reader and dispatcher that can create or resume an attempt.
3. **Persist the fence notice.** CP must durably record the `rollbackFence` facts it receives.
4. **Disposition actions** (from `classifyLeadTurnRollback`):
   - `fence_required`: do not route. Fence first.
   - `no_effect_recorded`: may admit under a **new** CP attempt on the previous path. Never reuse the
     Adea `attemptId`.
   - `reconcile_uncertain_effect`: never re-dispatch. Reconcile by dispatch or effect identity (REQ 102)
     before any resume.
   - `in_flight_fenced`: runtime-owned. Observe only.
   - `terminal_retained`: history. Nothing resumes.
   - `blocked_unclassifiable`: stop and refer to operator review.
5. **Lock order.** The CP claim must not hold the attempt lock while waiting on the admission. Adea
   locks the intent before the runtime row, so CP must follow the same ordering for any shared row.
6. **Error codes the CP path must mirror:** `LEAD_TURN_FENCED`, `ROLLBACK_FENCE_FORBIDDEN`,
   `INVALID_ROLLBACK_FENCE_REQUEST`, `LEAD_TURN_FENCE_EVIDENCE_INVALID`.

Until items 1 and 2 are implemented and tested in the CP repo, the rollback window is **not safe**.
Pre-fence code ignores the fence.

## Cross-repo and open dependencies

- control-plane [#940](https://github.com/adea-ai/control-plane/issues/940) (L3) and
  [#942](https://github.com/adea-ai/control-plane/issues/942) (P2): owners of the CP contract above.
  Their active branches were not edited.
- control-plane [#186](https://github.com/adea-ai/control-plane/issues/186) (reuse gate): not checked
  here.
- Adea [#1175](https://github.com/adea-ai/adea/issues/1175) and
  [#1180](https://github.com/adea-ai/adea/issues/1180): open upstream dependencies. #1174 is closed.

## Validation

Run on `feat/issue-1220-rollback-fencing` against a local Postgres 16 container, migrations 0001–0047
applied, `db:verify` passed (48 applied migrations).

- Focused lead-turn integration suites (`lead-turn-historical`, `lead-turn-rollback`, `lead-turns`,
  `lead-turn-runtime`, `lead-turn-product`, `lead-topic-migration`, `workspace-leads`): 51 pass,
  0 fail.
- Full `packages/db` integration, 60 s per-test timeout: 233 pass, 11 skip, 1 fail. The failure is
  `task-submissions` "operator entry refuses a wrong target". It also fails on clean `origin/main` in
  this environment, so it predates this change.
- `packages/db` unit: 229 pass, 0 fail (14 files).
- `apps/web` tests, using the package's own script invocation (`bun test --conditions=browser
test/*.test.ts start/ui-tailwind-sources.test.ts`): 442 pass, 0 fail (72 files).
- Root `format:check`: exit 0. Root `oxlint --deny-warnings`: exit 0. `packages/db` typecheck and
  `apps/web` typecheck: exit 0.
- Not run in this pass: root `typecheck` via turbo (the pre-commit hook runs it on commit), root
  `test:coverage`, Playwright E2E, packaged and desktop suites, performance, soak, and root `build`.
