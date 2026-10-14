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
  observed, reconciled and cancelled through it with an explicit purpose: `read`, `bind` or `cancel`.
  Current workspace membership, current channel participation and the channel row are checked on every
  call, and the reader must still be able to see the message. For an archived channel the pinned execution
  comparison is replaced by those live checks, because archival bumps the channel version. An active direct
  channel keeps the full pinned `lockAuthority` path unchanged. An active group admission (#1232) is reachable
  only through `bind` and `cancel`, only for the original claim holder, and with the full current group
  authority of an effect. Reads never reach a group, and archived groups are denied for every purpose.
- **Canonical readers now use the historical boundary:** `readLeadTurnRuntime` (purpose `read` by default),
  `getLeadTurnForUser`, `getLatestLeadTurnForChannel`, `observeLeadTurnRuntime` and
  `recoverLeadTurnRuntimeBinding` (`bind`), `requestLeadTurnCancellation` (`cancel`: actor only, with the same
  `runtime.invoke` and audience checks as an active cancel), `readLeadTurnRollbackState`, and
  `resolveLeadTurnAuthority` with purpose `read`, `cancel` or `effect`.
- **App runtime purposes** (`apps/web` `LeadRuntimeStore.authorize`): `status`, `progress`, the
  binding-recovery recheck and the snapshot request `read`. `cancel` requests `cancel`. `prepare` and
  `dispatch` request `effect`.
- **Effect authority is unchanged and active-only:** `createLeadTurn`, `prepareLeadTurnRuntime`,
  `markLeadTurnDispatchPending`, `authorizeLeadTurnFundingBinding`, `publishLeadTurnResult` (it
  appends a new Message), and the product reader that feeds CP dispatch.
- **Effect gates** on `prepare`, `dispatch`, funding and publication refuse fenced admissions with
  `LEAD_TURN_FENCED`.
- **Pure classifier** `classifyLeadTurnRollback` with dispositions `fence_required`,
  `no_effect_recorded`, `reconcile_uncertain_effect`, `in_flight_fenced`, `terminal_retained` and
  `blocked_unclassifiable`. Unknown or inconsistent evidence fails closed.

## Authority purposes

| Purpose                                                         | Who                                                        | Archived channel  | Active group channel                 | Fenced admission                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------- | ----------------- | ------------------------------------ | ------------------------------------------------------------------ |
| read                                                            | current workspace member and current user participant      | allowed (REQ 045) | denied                               | allowed (reconcile)                                                |
| bind (observe, recover binding)                                 | current participant                                        | allowed (REQ 045) | original claim holder only           | allowed (reconcile)                                                |
| cancel                                                          | original actor, plus `runtime.invoke` and audience members | allowed (REQ 045) | original claim holder only           | allowed (reconcile)                                                |
| effect (prepare, dispatch, funding, new turn, publish, product) | original actor, active channel, pinned                     | denied            | original actor, full group authority | denied for prepare, dispatch, funding, publish; product fence-only |

An active group admission takes the same current authority as an effect (effective admission, live lead,
participants, audience and role) through `lockAuthority`, and only for its original claim holder. Archived group
admissions stay denied for every purpose, because no group history rule exists yet. Redispatch is denied by every
path: archived or fenced, `prepare` and `markDispatchPending` refuse.

## Schema

Migration file: `packages/db/drizzle/0054_lead_turn_rollback_fence.sql`, journal idx 54, snapshot
`meta/0054_snapshot.json` generated by drizzle-kit on top of canonical `0053_retention_cleanup_authority`. Its SQL depends
only on `lead_turn_intents` (0043). No other table is changed. This slot was chosen by rebasing onto main at 0053 (#1243, retention); the
earlier 0047 and 0051 slots are gone, so whichever of this and the addressed-agent coordinator migration merges
second takes the next free number.

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

A terminal admission is fenced the same way. It returns `fenced: true` with disposition
`terminal_retained`, and the runtime row is not modified. A repeat call returns `alreadyFenced: true`
with the original attribution.

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
- **Terminal admissions are fenced (decision applied on this head; PostgreSQL 18 run passed, see Validation).**
  `fenceLeadTurnForRollback` records the fence on a terminal admission (`completed`, `failed`,
  `cancelled`, `timed_out`) with disposition `terminal_retained`. A completed result that was never
  published is then refused by `publishLeadTurnResult` with `LEAD_TURN_FENCED`, before the grant is
  consulted. The A31 case in `packages/db/tests/integration/lead-turn-rollback.test.ts` covers all four
  terminal states, and it passed in the PostgreSQL 18 run recorded in Validation.
  The product reader now emits the v2 fence-only body for these admissions, with
  `dispatchPermitted: false`.
- **Fence/effect lock inversion repaired.** The fence discovers the immutable channel reference
  without locking the intent, resolves current actor authority, locks the channel, then rereads the
  scoped intent under its update lock. A parked two-connection regression observes the real PostgreSQL
  blocker: the old intent-first fence deadlocks when the channel owner checks the intent; the repaired
  channel-first fence lets that effect commit, then records the fence. Runtime evidence is unchanged.
- **Fenced recovery stays available.** A fenced admission can still reconcile an uncertain dispatch binding
  through `recoverLeadTurnRuntimeBinding`, as the archived-history reconciliation tests require. That is not
  a resume, and it creates no new effect.

## CP contract (control-plane #940 / #942)

### What was verified against the real CP consumer (read-only)

Control-plane source snapshot at `c67b4bd` (`chore(main): release 1.92.0 (#1078)`, the
checkout's HEAD). Its CHANGELOG records `m18-01-3-fence-v2-consumer` (#1066, commit `c97e91d`). The
checkout was not edited. On this head, `apps/web/test/lead-product-contract.test.ts` ran against it with
`CONTROL_PLANE_CHECKOUT` set: 11 pass, 0 fail, 0 skip. Those tests run CP's `ProductionLeadProductEvidenceSchema`,
`createProductionProductHttpReader` and the CP authority against the golden fixtures in
`apps/web/test/contracts/`. They cover:

- the unfenced v1 body, which the strict evidence parser accepts, and the fence-only v1 body, which it refuses;
- pinned v2 fence facts, which CP preserves without accepting them as new-admission evidence;
- the v1 fence policy, which refuses every action;
- expiry and the archived 404 for unfenced evidence, and fence facts that do not parse as admission evidence.

Source reading at the same checkout shows the v2 consumer:

- `apps/control-api/src/models/lead-product-fence.ts`: `FENCED_OPERATION_POLICY_V1` refuses every operation.
  `FENCED_OPERATION_POLICY_V2` observes `status` and `progress`, allows `cancel` as the original actor only,
  and refuses `prepare`, `dispatch`, `resume` and `publication`. `parseLeadProductFence` throws
  `PI_PRODUCT_READER_UNAVAILABLE` for unknown fence schemas and identity mismatches.
- `apps/control-api/src/models/production-product-http.ts` and `production-lead-product.ts` parse fenced
  bodies through `parseLeadProductFence`.
- `apps/control-api/src/pi-durable/node-admission.ts` (`#fencedResolve`, `#assertFencedCurrent`) routes
  fenced results through that policy before any marker, inbox, attempt or model path runs.

The earlier checkout (`ec742819`) refused read-safe observation of a fenced admission. That statement is
superseded by #1066.

### Coordinated change in the control plane (merged as #1066)

1. **Split the evidence gate by operation.** Implemented: the per-operation policy is in
   `lead-product-fence.ts`, and `node-admission.ts` applies it. `cancel` checks actor continuity (the fence's
   canonical actor must be the retained one). The scope and principal checks listed in the original proposal
   were not re-verified line by line in this pass.
2. **Accept the fence-only variant.** Implemented: `production-product-http.ts` and `production-lead-product.ts`
   both parse fenced bodies through `parseLeadProductFence` and return a typed fenced result.
3. **Keep archived publication and archived admissions denied.** Adea still returns 404 for archived
   admissions. The CP-side handling of archived observation was not re-verified in this pass.

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
5. **Lock order.** The CP claim must not hold the attempt lock while waiting on the admission. Adea's
   authority and fence paths acquire the channel lock before dependent intent/runtime locks. The fence
   then locks intent before runtime. CP must preserve compatible ordering for any shared row.
6. **Error codes the CP path must mirror:** `LEAD_TURN_FENCED`, `ROLLBACK_FENCE_FORBIDDEN`,
   `INVALID_ROLLBACK_FENCE_REQUEST`, `LEAD_TURN_FENCE_EVIDENCE_INVALID`.

The two CP changes that gate fenced reads (the split evidence gate and fence-only acceptance) are
implemented in #1066 and exercised by the contract tests above. The rollback window is still **not declared
safe** here. CP claim-time enforcement, fence persistence, disposition handling and the lock-order obligation
were not re-verified in CP in this pass. Pre-fence code ignores the fence.

## Cross-repo and open dependencies

- control-plane [#940](https://github.com/adea-ai/control-plane/issues/940) (L3) and
  [#942](https://github.com/adea-ai/control-plane/issues/942) (P2): owners of the CP contract above.
  Their active branches were not edited.
- control-plane #1066 (`m18-01-3-fence-v2-consumer`): merged on the CP main line. See the CP contract above.
- control-plane [#186](https://github.com/adea-ai/control-plane/issues/186) (reuse gate): not checked
  here.
- Adea [#1175](https://github.com/adea-ai/adea/issues/1175) and
  [#1180](https://github.com/adea-ai/adea/issues/1180): open upstream dependencies. #1174 is closed.

## Validation

Rebased onto `origin/main` at `f1c38ca9` (migration 0052). Local PostgreSQL 16 with the repository's own
role setup. The packages were rebuilt before the web checks.

- Migration chain: `drizzle-kit check` passes. `db:migrate` on a fresh database verifies 54 applied
  migrations. A database migrated with main's folder (53) upgrades to 54 with this folder, a rerun is a no-op,
  and the five columns, four checks and the immutability trigger each exist once.
- `packages/db` integration, whole suite: 645 pass, 2 fail. The first failure was the pinned migration count in
  `migration-journal-order.test.ts` (53 to 54), fixed here and passing. The second,
  `job-outbound-result-store` "a large hidden run is gated in pages", exceeds the default 5 s test timeout in
  this environment, is in code this change does not touch, and passes (68 pass) with `--timeout 60000`.
- Focused: `lead-turn-rollback`, `lead-turn-historical`, `lead-turn-fence-envelope-negative`,
  `group-lead-cancellation`, `lead-turn-runtime`, `lead-turns`, `lead-turn-product` and the rollback unit file:
  88 pass, 0 fail. The parked two-connection race and the group claim-holder cases are in these files.
- `packages/db` unit: 426 pass, 0 fail.
- `apps/web` unit suite: 664 pass, 15 skip, 0 fail. `tsc --noEmit` is clean in `packages/db` and `apps/web`.
- `apps/web` route integration, one file per process as CI runs them: `lead-turn-cancel-route` 3 pass,
  `lead-handoff-route` 7, `lead-observed-target` 3, `lead-turn-conflict` 1; `lead-product-fence-v2` against a
  disposable `pinned_fence_v2_` database migrated to 0054: 9 pass.
- CP contract (`lead-product-contract.test.ts` with `CONTROL_PLANE_CHECKOUT` at control-plane `d632197`,
  built): 11 pass, 0 fail.
- `oxfmt --check .` and `oxlint --deny-warnings` clean.
- Not run: `apps/web` build and bundle checks, E2E, packaged and desktop suites, root `test:coverage`.
