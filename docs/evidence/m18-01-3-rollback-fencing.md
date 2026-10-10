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

Migration file: `packages/db/drizzle/0051_lead_turn_rollback_fence.sql`, journal idx 51, snapshot
`meta/0051_snapshot.json` with `prevId` = canonical 0050 (`abcf1389-…`). Root reserved 0051 for rollback
after canonical 0047–0050, which this branch imports byte-identical from
`feat/group-participation-policy-1178`. Its SQL depends only on `lead_turn_intents` (0043). No other table
is changed.

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

**Reconciled.** The earlier local `0047` is removed. Canonical `0047_requested_role_model_selections`
through `0050_group_legacy_backfill` are imported unchanged. The rollback SQL and trigger are unchanged
and now live at `0051`, with a snapshot that is canonical 0050 plus the five columns and four checks above.
Conflicts that remain for root, including #1177's divergent 0047 and its own 0051 slot, are in
[m18-01-3-migration-collision.md](m18-01-3-migration-collision.md).

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

### What was verified against the real CP consumer (read-only)

Control-plane checkout `Adea/control-plane` at `ec742819` (HEAD). Its working tree had unrelated
uncommitted edits, which were not touched. The contract test in `apps/web/test/lead-product-contract.test.ts`
runs CP's own `ProductionLeadProductEvidenceSchema` and `createProductionProductHttpReader` against the
golden fixtures in `apps/web/test/contracts/`, when `CONTROL_PLANE_CHECKOUT` points at a checkout. Result:

- Unfenced v1 body: the strict parser accepts it, and `readCurrent` returns evidence.
- Fence-only body (`pi-lead-intent-fence/v1`): the strict parser rejects it, and `readCurrent`
  throws `PI_PRODUCT_READER_UNAVAILABLE`. Effects therefore fail closed.
- CP's `NodePiDurableLeadAdmission.resolveIntent` and `assertCurrent` (`pi-durable/node-admission.ts`)
  call `#evidence()` for every operation, including `status`, `progress` and `cancel`, and map any failure
  to `PI_LEAD_UNAVAILABLE`. Read-safe observation of a fenced admission is therefore refused today.
  Changing the Adea response alone does not fix that.

### Coordinated change required in the control plane (not implemented here)

1. **Split the evidence gate by operation** in `node-admission.ts`:
   - `prepare` and `dispatch`: full v1 evidence required, and a fenced admission is refused.
   - `status` and `progress`: require `execution:read`, the service principal in `allowedPrincipalIds`
     and `scopeRef` equal to the retained marker's `scopeRef`. Skip the full-evidence digest check for
     fenced admissions, because the full evidence is not emitted for them.
   - `cancel`: require `execution:cancel`, the service principal in `allowedPrincipalIds`, and
     `canonicalActorPrincipalId` equal to the retained marker's actor. Cancellation stays actor-authorized.
2. **Accept the fence-only variant** in `production-product-http.ts` and `production-lead-product.ts`.
   Parse `pi-lead-intent-fence/v1` strictly and return a typed fenced result, not `undefined` and not a
   throw. Only the operations in item 1 may consume that result.
3. **Keep archived publication and archived admissions denied.** Adea returns 404 for archived
   admissions, which CP reads as unavailable. Archived observation for CP is a separate decision.

### Required Adea-side change (blocked, see the status note below)

The fence-only body must also carry the pins and identity that item 1 needs: `authorityRevision`
(the channel version), `canonicalActorPrincipalId`, `scopeRef` and `allowedPrincipalIds`. These are
identity and pin fields only, with no prompt, profile or message content. The unfenced path does not
change. The change is in `apps/web/src/server/lead-product-reader.ts`: compute the actor and scope
before the fence branch, and move the freshness check after it. The edit was denied by the auto-mode
permission classifier, so it was not applied. The branch's handler is at the committed version, and
the fence-only fixture is at its current shape. A follow-up contract fixture update will be needed
when it lands.

### Remaining CP obligations

1. **Refuse on the fenced shape.** Treat `schemaVersion: pi-lead-intent-fence/v1` as a refusal to
   dispatch and never parse it as an admission. An unknown schema also means refuse.
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

**Current chain proof (canonical 0047–0050, then rollback as 0051).** Local Postgres 16 container, with
databases created for this proof only.

- `db:check` passes ("Everything's fine").
- Fresh install of the full folder: 52 migrations applied. `db:verify` passes (52 applied migrations).
- Upgrade from canonical 0050: the folder comes from `git archive` of
  `origin/feat/group-participation-policy-1178`. It applies 51 migrations. Three `lead_turn_intents`
  fixture rows are seeded with FK triggers skipped for that transaction only; CHECK constraints apply.
  The full folder then applies 0051 (52 total). A rerun is a no-op.
- Retention: the fingerprint of the fixture rows (excluding the five new columns) and of the canonical
  migration rows is identical before and after. Only these fixture rows exist; every other app table is
  empty, so this proves retention for those tables only.
- `0051` is recorded exactly once. The trigger and four checks each exist once. `pg_dump -s` of the fresh
  and upgraded databases differs only in pg_dump's per-run `\restrict` token.
- After the upgrade, a change to fenced attribution is refused with
  `lead_turn_intents_rollback_fence_immutable`.
- `lead-turn-historical` and `lead-turn-fence-envelope-negative` integration suites: 21 pass, 0 fail,
  against the fresh full-folder database.
- Not run on this head: the full `packages/db` integration suite and the repo CI runners. Those are
  listed in the PR body.

**Earlier run, before reconciliation (local 0001–0047 chain, kept for history).** Run on
`feat/issue-1220-rollback-fencing` against a local Postgres 16 container, migrations 0001–0047 applied,
`db:verify` passed (48 applied migrations).

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
- Cross-product contract (`apps/web/test/lead-product-contract.test.ts`): 8 pass with
  `CONTROL_PLANE_CHECKOUT` set to the control-plane checkout at `ec742819`. Without a checkout, 3 pass
  and 5 skip. CI does not set the variable, so the CP-consumer tests skip in CI.
- Negative contract checks, all passing:
  - Adea side: expired unfenced evidence is 404 at the expiry boundary and admitted one millisecond
    before it. An archived admission is 404 whether the lookup returns nothing or denies.
  - Runtime, `lead-turn-negative-contract.test.ts`: a refused effect authority stops prepare and
    dispatch before any adapter call. A fenced dispatch refused at pending reaches no runtime
    dispatch. Archived publication is withheld.
  - Database, `lead-turn-historical.test.ts`: a fenced admission is refused at effect authority,
    before any runtime call. Archived effect authority is denied while archived read and cancel
    authority stay available. Archived publication writes no message.
  - CP side, through CP's real production authority: expired v1 evidence is `PI_PRODUCTION_PRODUCT_DENIED`,
    and the same bytes are admitted before expiry. Fenced evidence is `PI_PRODUCT_READER_UNAVAILABLE`.
    An archived 404 yields no evidence.
- Code change in this pass beyond tests: `resolveLeadTurnAuthority('effect')` now refuses a fenced
  admission before the runtime is called. This adds a denial. Previously `adapter.prepare` could run
  before the fence check at `store.prepare`.
- Envelope negatives against the real handlers (committed, all passing against the committed code):
  `apps/web/test/lead-product-fence-envelope-negative.test.ts` covers the signed reader for missing,
  stale and mismatched envelopes. `apps/web/test/lead-turn-status-cancel-negative.test.ts` covers the
  status and cancel service for missing, stale and mismatched runtime responses.
  `packages/db/tests/integration/lead-turn-fence-envelope-negative.test.ts` covers the rollback reader
  and the effect and cancel authority.
- Gaps the committed handler does not refuse, found by probing it. They are not committed as tests,
  because they would fail. (a) A product with `dispatchPermitted: false` and no envelope is served as
  a dispatchable v1 admission with the prompt. The database never produces that combination, but the
  handler does not check it. (b) A malformed envelope, a `fencedAt` in the future or an unknown actor
  kind is emitted unvalidated. A fence envelope that contradicts `dispatchPermitted: true` is also
  emitted.
- Unapproved proposal (uncommitted, not applied, not in this branch): an additive, insertion-only
  handler patch that closes (a) and (b) and adds the identity and pin fields. It comes with its tests
  and fixture updates, in the worktree folder `review/lead-1244-envelope-proposal.patch`. The gap tests
  fail against the committed handler and pass against the patched copy, and the patch dry-runs with
  `git apply --check`.
- Migration collision with #1229 is recorded in `docs/evidence/m18-01-3-migration-collision.md`.
  Nothing is renumbered.
- Not run in this pass: root `typecheck` via turbo (the pre-commit hook runs it on commit), root
  `test:coverage`, Playwright E2E, packaged and desktop suites, performance, soak, and root `build`.
