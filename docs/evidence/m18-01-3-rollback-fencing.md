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

**Fenced admission (v2).** The response is fence facts plus retained pins. It carries no prompt, profile,
message or dispatch field, so no prepare, dispatch or resume can be built from it. The discriminator is
`pi-lead-intent-fence/v2`, a new schema rather than a widened v1.

```json
{
  "schemaVersion": "pi-lead-intent-fence/v2",
  "intentId": "<uuid, the requested intentId>",
  "workspaceId": "wsp_<26-char, the requested workspaceId>",
  "dispatchPermitted": false,
  "rollbackFence": {
    "fencedAt": "<canonical UTC ISO-8601, not later than Adea's clock>",
    "reason": "rollback_cohort | operator_intervention",
    "actor": { "kind": "user", "userId": "<uuid>" }
  },
  "authorityRevision": "<channel version of the current canonical product>",
  "canonicalActorPrincipalId": "user:<original admission actor>",
  "scopeRef": "adea-product:sha256:<64 hex, the same digest as the unfenced admission>",
  "allowedPrincipalIds": ["<the principal the service proof verified>"]
}
```

`rollbackFence.actor` is `{ "kind": "operator", "operatorId": "<id>" }` for operator fences. The four pins
come from the same canonical product that signs unfenced evidence. `canonicalActorPrincipalId` is the original
admission actor, never the fence actor. `scopeRef` is computed by one shared function for both variants, so
a retained marker from before the fence still matches while the product state is unchanged. The response has
`cache-control: private, no-store` and returns HTTP 200.

The old minimal `pi-lead-intent-fence/v1` body is no longer emitted. Its fixture stays as a fail-closed
reference, and any parser that does not know v2 must refuse v2.

**Envelope gate (checked before any branch).** A product with `dispatchPermitted: false` needs a fence,
and a product with a fence needs `dispatchPermitted: false`. The fence must have exactly the keys
`actor`, `fencedAt` and `reason`. `reason` must be one of the two values above. The actor must be exactly
`{ kind, userId }` with a UUID, or `{ kind, operatorId }` with a valid operator id. `fencedAt` must be in
canonical UTC form and not later than the verifier's clock, with no skew tolerance. Anything else is
refused with the same 404 and no fence facts. The fence response's `intentId` and `workspaceId` are the
requested selectors, after the product's identity has been checked against them. A fenced admission past
its lifetime still returns fence facts only. The normal freshness check and the signature, membership
and audience checks are unchanged.

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
- **Terminal admissions are not fenced (open decision).** `fenceLeadTurnForRollback` returns
  `fenced: false` without writing when the runtime is already terminal (`completed`, `failed`, `cancelled`,
  `timed_out`). A completed result that was never published, and whose admission was never fenced in flight,
  can therefore still publish through `status`. The caller sees `fenced: false`. Root decides whether a fence
  request on a terminal, unpublished admission should record the fence, or refuse loudly. No test asserted the
  old behaviour, and this head does not change it.
- **Fenced recovery stays available.** A fenced admission can still reconcile an uncertain dispatch binding
  through `recoverLeadTurnRuntimeBinding`, as the archived-history reconciliation tests require. That is not
  a resume, and it creates no new effect.

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

### Retained pins (v2, approved by root and implemented on this head)

The v2 fenced body carries `authorityRevision`, `canonicalActorPrincipalId`, `scopeRef` and
`allowedPrincipalIds`, as described above. They are derived from the current canonical product, under the same
locks as the unfenced evidence. They are disclosed only through the existing signed, scoped reader. The CP
consumer may observe with them and may cancel only as the original actor. Its prepare, dispatch, resume and
publication paths refuse fenced results. The typed consumer proposal and the immutable producer fixtures are in
[m18-01-3-cp-consumer-proposal.md](m18-01-3-cp-consumer-proposal.md).

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

**Real product proof for pinned v2 (`apps/web/test/integration/lead-product-fence-v2.test.ts`).** Runs only with
`PINNED_FENCE_V2_DATABASE_URL`, which must name a database with the `pinned_fence_v2_` prefix. The database is
created for the run and migrated with the repository's own migrator (`packages/db` `verify-migrations`: 52
migrations, verification passed). The reader is the real handler, with the real DB reader and the real
service-token verifier. Tokens are signed in memory with generated Ed25519 keys, so no operator configuration
changes. The external CP runtime adapter is a stub, and it is the only fake. Results: 9 pass, 0 fail.

- Matching: the retained v1 unfenced pins still match the v2 body after the fence. Status, progress and
  original-actor cancel succeed through the real product service.
- Original actor only: another admin cannot cancel, and the adapter is not called.
- New effects: prepare, dispatch, a new attempt and publication are refused before any runtime call.
- Concurrent actor change (membership removed while the reader runs): the read is either the matching body or
  404, and status and cancel are refused afterwards.
- Concurrent ownership change (role downgraded below `runtime.invoke`): read and cancel are refused.
- Concurrent placement change: the database refuses moving the workspace lead or its topic into a project
  (`agents_workspace_lead_standalone`). The retained pins still match.
- Concurrent audience change (a participant added during the read): the read is either the matching body or 404. Afterwards the reader refuses, so a retained scopeRef cannot be revalidated.
- Wrong principal, wrong workspace and wrong intent: no pins, and no lookup for a verification failure.
- v1 and the exact v2 discriminator: a strict reference parser rejects the v1 fixture, extra fields, a trailing
  space in the discriminator and an unknown version. It accepts the emitted v2 body and the v2 fixture.

Race outcomes observed on one run: membership removal and role downgrade each returned 404 for the racing read.
The participant add returned 404, and the placement race returned the matching v2 body, since the placement
write was refused. No response mixed states.

**Pinned v2 and fenced publication proof (this head).**

- `packages/db` unit: 229 pass, 0 fail.
- `packages/db` integration, against the migrated database at 0051, with the known base failure excluded by
  name (`task-submissions > operator entry refuses a wrong target`, which also fails on `origin/main`):
  243 pass, 9 skip, 0 fail. The changed `lead-turn-rollback` and `lead-turn-historical` files: 32 pass.
- Red check on publication: with the new guard line removed from a temporary copy, the in-flight publication
  test resolved instead of refusing. With the guard, it refuses with `LEAD_TURN_FENCED`, consults no grant, and
  writes no message. The copy was removed afterwards.
- `apps/web` full suite: 490 pass, 6 skip, 0 fail. The 6 skips are the CP-checkout contract tests.
- Static: `tsc --noEmit` clean in `apps/web` and `packages/db`. `oxlint --deny-warnings` clean for `apps/web`
  and `packages/db`. Repo `oxfmt --check .` clean.
- Not run: `apps/web` `vite build`, E2E, packaged and desktop suites, root `test:coverage`, and the CP contract
  tests against a CP checkout. The v2 CP refusal test is skipped without `CONTROL_PLANE_CHECKOUT`, so it did not
  run here. Its fixture digests are in the CP proposal.

**Envelope gate proof (`c75e5a174`, `apps/web` only, before the pins and publication change).**

- Focused: `apps/web/test/lead-product-fence-envelope-gate.test.ts` (12 tests) and the existing
  `lead-product-fence-envelope-negative`, `lead-product-reader-fence`, `lead-product-reader` and
  `lead-product-contract` files: 32 pass, 5 skip (the contract tests need `CONTROL_PLANE_CHECKOUT`), 0 fail.
- Red check: the new gate file, run against a temporary copy of the earlier committed handler, gave 7 fail
  and 5 pass. The copy was removed afterwards.
- Full `apps/web` test suite (`bun --conditions=browser test test/*.test.ts start/ui-tailwind-sources.test.ts`):
  480 pass, 5 skip, 0 fail.
- `tsc --noEmit` in `apps/web`: exit 0. `oxlint --deny-warnings apps/web`: no findings.
  `oxfmt --check` on the changed files: clean.
- Not re-run: `apps/web` `vite build`, since its script runs `cf-typegen` and `sync-assets`, which write
  into the tree. The `packages/db` suites, root scans and E2E were not re-run, because this change does
  not touch them.

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
- Gaps found by probing the earlier handler, now closed on this head. (a) A product with
  `dispatchPermitted: false` and no envelope was served as a dispatchable v1 admission. (b) A malformed
  envelope, a `fencedAt` in the future, an unknown actor kind, or an envelope that contradicted
  `dispatchPermitted: true` was emitted unvalidated. `readFenceEnvelope` in
  `apps/web/src/server/lead-product-reader.ts` refuses all of these before any branch is chosen. Its tests
  are in `apps/web/test/lead-product-fence-envelope-gate.test.ts`. Seven of them fail against the earlier
  handler. The other five (identity and preserved behaviour) pass against both.
- `review/lead-1244-envelope-proposal.patch` (untracked, not applied) also adds the identity and pin
  fields. This head does not apply it. Its validation is a subset of the committed gate, which is stricter:
  exact keys, canonical `fencedAt`, and UUID or operator-id actor refs.
- Migration collision with #1229 is recorded in `docs/evidence/m18-01-3-migration-collision.md`.
  Nothing is renumbered.
- Not run in this pass: root `typecheck` via turbo (the pre-commit hook runs it on commit), root
  `test:coverage`, Playwright E2E, packaged and desktop suites, performance, soak, and root `build`.
