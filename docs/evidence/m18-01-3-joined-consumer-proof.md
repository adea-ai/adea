# M18.01.3 — joined consumer proof against the signed control-plane reader

Evidence for [#1220](https://github.com/adea-ai/adea/issues/1220), a child of
[#1181](https://github.com/adea-ai/adea/issues/1181). Both stay open. This record adds a source-level
proof of the existing fence-v2 contract. It does not declare the rollback window safe, and it is not a
production qualification (see [Limits](#limits)).

## What it proves

`apps/web/test/control-plane-joined/lead-fence-v2.test.ts` joins Adea's real lead product to the control
plane's real consumer code at one exact control-plane revision, over the signed reader boundary.

Real on the Adea side: the Postgres lead-turn lifecycle (`prepareLeadTurnRuntime`,
`markLeadTurnDispatchPending`, `recoverLeadTurnRuntimeBinding`, `observeLeadTurnRuntime`,
`fenceLeadTurnForRollback`, `readLeadTurnRollbackState`), the signed reader
(`createLeadProductReaderHandler`) and its Ed25519 service verifier, and `createLeadTurnProduct` with the SDK
adapter.

Real on the control-plane side, loaded from the pinned checkout: the production product authority and HTTP
reader (`createProductionLeadProductAuthority`, `createProductionProductHttpReader`, `parseLeadProductFence`),
`NodePiDurableLeadAdmission` over SQLite with its retained marker and write-once admission binding,
`DurablePiDurableLeadService` with `SqlitePiDurableLeadReceiptStore`, the execution plan compiler and runtime
budget admission. The control plane restarts by closing and reopening its SQLite files. Adea restarts by
opening a new database connection and a new reader handler.

The contract under test is the existing one. Status, progress and original-actor cancel observe. Prepare,
dispatch, resume and publication refuse while fenced. No safe-resume path is added or exercised.

| Acceptance item                                            | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact source provenance                                    | `provenance`: HEAD equals the pinned revision, no tracked changes, the fence consumer commit is an ancestor, and the consumer policy table is exactly v2 observe/refuse                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Retained runtime identity                                  | `retained identity`: Adea's evidence, the control plane's marker, admission binding and receipt carry one execution, attempt, dispatch and runtime session, and the runtime started once                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Safe continuation, original identity, no duplicate effects | `continuation`: after the fence and a restart of both sides, status, progress and original-actor cancel reach the original handle; start stays 1; the only stored change is the cancel's own command binding, and the receipt, retained marker, admission binding and every other control-plane row are identical; a retried cancel reuses the same handle and idempotency key                                                                                                                                                                                                                                               |
| Continuation does not depend on the evidence lifetime      | `observation and cancel keep working after the evidence lifetime`: with the handler clock 600 s ahead, a fenced body is still served and the unfenced body is refused                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Principal and actor limits                                 | `fence audience`: with caller and verified principal made consistent, a fence that names someone else is refused by the control plane's fence audience check (`PI_LEAD_SCOPE_REJECTED`) for status, progress and cancel, and the resolver denies a principal the fence does not name. The same body is accepted for the principal it names. The outsider is also refused earlier by its receipt, before Adea is read, which is a separate defence. Nothing is stored: runtime effects, every control-plane row and every Adea row are identical, because these refusals happen during resolution, before any command binding |
| Refusal while fenced                                       | `refusal`: prepare, dispatch, lookup and publication refuse on both sides across a restart. The control-plane refusals store only the refused dispatch's own command binding; the Adea-side refusals (prepare, dispatch, publication) leave every control-plane row, every Adea row (including messages) and the runtime effects identical                                                                                                                                                                                                                                                                                   |
| Uncertain effect across restart and retry                  | `uncertain effect`: the runtime starts but its result is lost. The control-plane receipt stays `dispatching` with no handle, and Adea stays `dispatch_pending` with no binding. After a fence and a restart of both sides, every retry, status, progress, cancel and lookup is refused. Start stays 1. The only stored change is the command bindings of the three refused mutating commands; the receipt, marker, admission binding and Adea rows are identical, and Adea's own reconciliation attempt stores nothing. Adea reports `reconcile_uncertain_effect` and never redispatches                                     |
| Unavailable evidence                                       | transport failure and an upstream 503 refuse everything, storing nothing. Once Adea is reachable again, the same fence applies and dispatch is still refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Unknown evidence                                           | an unknown schema, `dispatchPermitted: true`, an extra field, an empty audience, a future `fencedAt` and a mismatched intent are each refused. Status, progress and the resolver store nothing; a refused dispatch stores only its own command binding                                                                                                                                                                                                                                                                                                                                                                       |
| Stale evidence                                             | a retained marker whose revision or scope no longer matches the fence conflicts (`PI_LEAD_AUTHORITY_CONFLICT`). A participant change moves Adea's pinned audience, so the reader answers 404 `LEAD_PRODUCT_UNAVAILABLE` and the consumer learns nothing. With the marker restored, the stores equal what they were before the tamper, and the conflict is raised before any command is bound                                                                                                                                                                                                                                 |
| Revoked evidence                                           | removing the original actor makes the reader answer 404, so observation and cancel are refused and the fence stays, with the same storage result as above                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

A 404 `LEAD_PRODUCT_UNAVAILABLE` from Adea is never read as "not fenced" by the control plane.

### What "unchanged" covers

Every refusal test snapshots, before and after, the runtime effect counts, every row of every table in the
control-plane SQLite file (receipts, retained markers, admission bindings, budgets, plans, executions, usage,
catalog and command bindings), and Adea's lead-turn intents, runtime binding and messages for the tenant. They are
compared whole.

Result: a refusal leaves everything unchanged except one thing. **A refused mutating command records its own
idempotency binding** in `pi_lead_commands` when it is refused after the binding step. That is a stored change,
and it is asserted at full precision:

- Rows are indexed by the complete stored key, `[workspace, principal, idempotency key]`, never by the
  idempotency key alone.
- Every row that existed before is still present with the same complete key and the same digest, and no
  complete key appears twice.
- The new rows are exactly the expected ones, each with its exact workspace, principal, idempotency key and
  digest. The expected digest is recomputed from the first envelope the test issued under that key
  (operation, payload, workspace, project and `issuedAt`) and matches what the service stored.
- The row count is the previous count plus the expected new rows, so an extra row under the same idempotency
  key and another scope cannot pass.

| Refused command                                                               | Binding recorded                               |
| ----------------------------------------------------------------------------- | ---------------------------------------------- |
| dispatch (any refusal reason that reaches the service)                        | yes                                            |
| cancel refused because the retained handle is unproven                        | yes                                            |
| cancel refused by the fence audience check or by a revision or scope conflict | no, refused during resolution                  |
| status, progress, lookup, resolver                                            | no                                             |
| Adea prepare, dispatch and publication                                        | no, Adea refuses before any control-plane call |

So the claim is: no refusal changes a receipt, retained marker, admission binding, budget, plan, execution,
Adea row or runtime effect. A refused dispatch or unproven-handle cancel does add one command-idempotency row.
The row stores only the key and a digest. It is still a write a refusal makes, it grows with distinct keys, and
a retry that reuses the key with a different `issuedAt` meets `PI_LEAD_COMMAND_CONFLICT` instead of the fence
refusal. Whether it should be written before the fence
decision is a control-plane question for #1047/#1048, not changed here.

## Archived admissions

The same file proves the existing contract for admissions whose channel is archived, **before** the fence
and **after** it (`archived admissions`, six settled cases and four cancellation interleavings in each of
the two orders, twenty tests). Each case restarts both sides, and the fence-first order also checks that
Adea still emits the v2 fence body while the channel is active, before it is archived.

What archiving does to the contract, at the pinned control-plane revision:

- Adea's signed reader serves only an active channel. An archived admission is a 404
  `LEAD_PRODUCT_UNAVAILABLE` whether or not it is fenced, and whichever order the two happened in. The
  control plane reads that as "no product", never as "not fenced", so it can neither observe nor cancel an
  archived admission through the reader. Archiving does not widen what the service can reach: it narrows it.
- The fence itself still works on an archived channel. It records the channel's lifecycle in the fence
  authority (`archived` when archived first, `active` when fenced first) and a second fence returns the first
  attribution unchanged.
- Adea's own historical boundary is unchanged: a current participant can still read the retained admission
  (`readLeadTurnRollbackState`: archived, fenced, retained execution, attempt, dispatch and session). That
  grants no effect.

| Case (each in both orders)             | What the test asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running`                              | Archive and fence write no control-plane row at all. On Adea only the intent's five fence columns and `updated_at` change; the runtime row, messages, participants and receipt are identical. All consumer operations are refused across a second restart, a refused dispatch storing only its own command binding. Every Adea effect is denied and stores nothing. The runtime started once and was never cancelled                                                                                                                                                                                                              |
| `uncertain start`                      | The lost-result start stays `dispatching` on the control plane and `dispatch_pending` on Adea, with no handle on either side. After the fence and a restart, the joined lookup, status, progress and cancel are refused, and the two refused dispatches store only their own two command bindings (the cancel is refused while resolving, so it stores none). Prepare, another attempt, dispatch, dispatch-pending and publication are denied by Adea, and a binding for another execution or attempt is refused. Start stays 1 and one session exists. Recovery of the retained attempt is a separate, permitted path; see below |
| `revoked`                              | After the original actor is removed, the reader is a 404, the control plane cannot observe or cancel, and the revoked actor cannot read, cancel, record a binding or record an observation. The owner, still a participant, can read the history                                                                                                                                                                                                                                                                                                                                                                                  |
| `wrong principal`                      | A workspace member who is not a participant and a user outside the workspace cannot read, status, cancel, record or fence (`ROLLBACK_FENCE_FORBIDDEN` for a plain member), before or after the real fence, and nothing is stored. The first fence keeps its owner attribution. On the control plane a principal outside the receipt is refused before Adea is read (`PI_LEAD_SCOPE_REJECTED`, no reader call)                                                                                                                                                                                                                     |
| `terminal`                             | A completed admission is fenced as `terminal_retained`; its runtime row is unchanged, publication is denied, nothing is published, and a second fence returns the first attribution                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cancel`                               | The original actor's cancel is recorded once on Adea (the runtime row's `cancel_requested_at` and `updated_at`) and never reaches the runtime. The full snapshot is taken immediately after that first cancel; a second cancel, and a third after a restart of both sides, leave exactly that snapshot (every control-plane row, the runtime effect counters, and Adea's intent, runtime, messages, channel and participants). The uncertain-start test repeats this after the one permitted write before a cancel, the same-attempt handle binding. See the first limit below                                                    |
| `cancel interleaving, running`         | The first cancel occurs before either transition or between them. While still active it reaches exactly the retained runtime handle, records its own command binding and observes `cancelling`; after archive it records only the Adea request. Each remaining transition changes only its own columns. A second cancel, restart and third cancel preserve the complete settled snapshot and original request time                                                                                                                                                                                                                |
| `cancel interleaving, uncertain start` | The retained attempt may be bound through historical recovery before either transition or between them, changing only `dispatch_id`, `runtime_session_id` and `updated_at`. The first cancel records the request on Adea; while active it also records its own command binding before refusing the receipt without a handle. No cancel reaches the runtime. Each remaining transition, repeated cancel, restart and third cancel preserve the unresolved receipt, session and cancellation request                                                                                                                                |

The eight additional interleaving tests place the first cancel before either transition or between them.
Together with the settled `cancel` and `uncertain start` cases, they cover all six first-cancel orders for
each of the running and uncertain-start admissions. In every case the second cancel happens after both
transitions and the third after both sides restart.

| First cancel             | Archive before fence     | Fence before archive     |
| ------------------------ | ------------------------ | ------------------------ |
| Before either transition | cancel → archive → fence | cancel → fence → archive |
| Between transitions      | archive → cancel → fence | fence → cancel → archive |
| After both transitions   | archive → fence → cancel | fence → archive → cancel |

**Blocked lookup, permitted recovery.** For the uncertain start these are two different paths and the proof
keeps them apart. The joined lookup that would prove the handle, and every control-plane read of it, is
blocked: the reader refuses the archived product, the receipt stays `dispatching` with no handle, and the
control plane learns and stores nothing. Recording the **same retained attempt's** binding on Adea
(`recoverLeadTurnRuntimeBinding`, historical `bind` access) is permitted, and the test does it with the
identity the runtime holds. It changes exactly the runtime row's `dispatch_id`, `runtime_session_id` and
`updated_at` on Adea. The control plane, the runtime effects, the intent, the messages, the channel and its
participants are identical, the control-plane lookup is still refused, the receipt is still `dispatching`,
and every denial above still holds afterwards. That identity is supplied by the caller and is not proved by
the control plane, so after recovery Adea holds a handle the control plane has not confirmed. A binding for
another execution or attempt is refused.

Denied on an archived admission (Adea answers `Lead turn unavailable` and stores nothing; the control plane
refuses with `PI_LEAD_UNAVAILABLE` or `PI_LEAD_SCOPE_REJECTED`): prepare of the retained attempt, prepare of
another attempt, mark dispatch pending, dispatch, publication, and on the control plane prepare, dispatch,
status, progress, cancel, lookup and the resolver.

Each of these comparisons snapshots the same things as the rest of the file: every control-plane SQLite row,
the runtime effect counts and complete retained runtime sessions, and Adea's lead-turn intents, runtime
binding and messages, together with the archived channel row and its participants. That expanded snapshot
is the one the control-plane refusal helper compares too, including any additional snapshot fields, so a
refusal that touched the channel, participants or session would fail it. Command bindings are compared by
their complete scoped key and digest.

Archive, fence, signed-reader calls and restart each have a complete before/after comparison. Archive may
change only the channel's `lifecycle_state`, `updated_at` and `version` (exactly one version increment);
fence may change only the intent's fence columns. A shared allowed-column assertion compares the whole
snapshot around both same-attempt recovery and the first archived cancel, so an unrelated write cannot
become the accepted baseline for the second and third cancels. The restart itself must leave that baseline
unchanged before the third cancel is attempted. Historical reads, denied principals and repeated fences
also compare complete snapshots.

Limits found while writing the proof. They are reported, not changed here:

- **Cancel on an archived admission is recorded, not delivered.** The original actor may record a cancel
  request through Adea's historical boundary (`cancel_requested_at` and `updated_at` change, nothing else), but
  the control plane cannot serve the cancel because the reader refuses the archived product. The runtime is
  never cancelled by that request. A request made while the channel is still active may already have
  reached its retained handle, as the interleaving cases show. Delivering an archived request would mean
  serving archived products to the service, which widens archived
  access, so it stays an owner decision.
- **The recording boundary stays open on archived and fenced admissions.** `recoverLeadTurnRuntimeBinding` and
  `observeLeadTurnRuntime` use the historical `bind` access and do not look at the fence or the archive. They
  can only bind the retained attempt (another execution, attempt, dispatch or session is refused, and the proof
  asserts that, and asserts the permitted recovery above), and they start, dispatch and publish nothing. Their callers are Adea's own trusted server code.
  They were not changed.
- The archived signed-reader behaviour above is Adea's, observed through the pinned control plane. The control
  plane has no archived-specific code in this revision.

## Provenance

| Item                                        | Value                                                                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control-plane repository                    | `adea-ai/control-plane`                                                                                                                                              |
| Pinned revision                             | `1aa42ff20c7fe1b0d9cc484983a7a631f4589746`                                                                                                                           |
| Fence consumer commit (ancestor of the pin) | `c97e91d40570d85076796709fc8304909afe4fcb`                                                                                                                           |
| Earlier joined pin                          | `6591925845a14509d5be3e694ba6a4ad3c422e08`, advanced because the fence consumer is not in its history. The existing `management-current` proof passes at the new pin |

The pin lives in `apps/web/test/control-plane-joined/control-plane-source.json`. The test fails, and does not
skip, when the checkout is missing, is at another revision, has tracked changes, or lacks the consumer commit.

## How it was run

```
ADEA_CONTROL_PLANE_SOURCE=<checkout at the pinned revision> bun run test:integration:control-plane-joined
```

The lane builds the Adea packages, provisions Postgres, and runs the directory from the control-plane
checkout. The expanded run on 2026-10-15 used Bun 1.4.0 and the two joined test files together on a freshly
migrated, isolated local database: 41 pass, 0 fail (37 in this proof, 4 in `management-current`), 2274
assertions. The 37 are the 11 proof tests, 6 regressions for the command-binding comparison itself and the
20 archived-admission tests. The control-plane checkout stayed clean at the exact pin; its packages were
built with its pinned Bun 1.4.2, with two Turborepo tasks at a time.

Additional repository checks passed: `bun run format:check`, `bun run lint` (17 tasks and the root check),
`bun run typecheck` (31 tasks), `bun run test:unit` (30 tasks followed by 1129 coverage tests),
`bun test scripts/docs-boundary.test.ts` (4 tests), and the five related database integration files
`lead-turn-rollback`, `lead-turn-runtime`, `lead-turn-historical`, `lead-turn-product` and
`lead-turn-fence-envelope-negative` (53 tests). Turborepo process concurrency was capped at two. The unit
run retained its existing 14 desktop and 15 web platform/fixture skips.

The fresh environment initially failed desktop tests because its default data directory was read-only
and its process umask was `0077`. The supported `ADEA_DATA_DIR` pointing at a writable disposable test
directory and a test-shell umask of `0022` resolved those failures, without source or check changes.
The web source-contract fixture was prepared with its checked-in setup command and frozen Zod 4.6.5
lockfile using the existing cache. A joined rerun against a previously used database hit the existing
`management-current` fixed workspace ID; the qualified joined run above used a fresh database.
Substantive CI stays skipped while the PR is a draft. No release, deployment or real-runtime validation
was performed.

Mutation checks, all reverted afterwards. The earlier checks below retain their original twelve-test
archived-suite counts; the expanded-suite checks are listed separately:

- Serving the unfenced body for a fenced product failed 6 of 11 tests.
- Adding a principal to the fenced audience failed 6 of 11 tests.
- Removing the fence audience check from the control plane's fenced resolver (and, separately, from both it and
  the post-effect guard) failed the audience test. Run against a modified control-plane checkout with the pin
  check relaxed for that run only, then reverted.
- A control-plane observation that rewrites the receipt failed 6 of 11 tests, and a refused resolution that
  writes a budget row failed the refusal and uncertain-effect tests. Run against a modified control-plane
  checkout with the pin check relaxed for that run only, then reverted.
- Command-binding comparison. Six regressions feed the comparison synthetic snapshots and require it to reject a
  changed digest on an existing row, an existing row replaced by the same idempotency key under another
  workspace or principal, an extra row that reuses an idempotency key under another scope, a new row with the
  wrong digest, scope or count, a duplicate complete key, a removed row and a change to any other table. With
  the comparison reduced to the idempotency key alone, four of the six fail. Against the pinned control plane
  with its binding store modified (pin check relaxed for that run only), each of three changes failed 7 of
  the 17 tests: rewriting the digest of existing rows, replacing the principal in existing keys, and writing
  an extra row under the same idempotency key for another principal.
- Archived admissions. With the `--conditions=development` resolution, so Adea's source is used instead of
  its build: lifting the active-channel lock and the channel-version pin made all 12 archived tests fail (the
  reader serves the archived product); making the fence refuse an archived channel failed 8 of 12; and removing
  the binding check from `recoverLeadTurnRuntimeBinding` failed 4 of 12. A repeated cancellation that rewrites the
  request time, and one that touches the channel row, each failed 4 of 12 (the cancel and uncertain-start tests);
  the previous head, which compared only the effect counters after the second cancel, passed both. Against the pinned control plane with
  a refusal that writes a row (pin check relaxed for that run only), all 12 failed. An Adea reader that
  rewrites the channel row on every read failed all 12; the previous head of this patch, whose refusal helper
  compared only the narrower snapshot, failed 6 of 12 under the same change.
- Expanded snapshots. Against `deaec7a301df825a19fb3211be77dd5e6f3fa7ba`, a first cancellation that also
  rewrites the intent's `updated_at` passed both archived uncertain-start tests. The shared complete
  comparison now rejects it in both. A restart fixture that makes an extra runtime status call passed all
  four archived running/terminal tests on that head; the explicit restart snapshot now fails all four.
  Rewriting the cancel request time on every repeat fails 12 of the expanded 20 archived tests (all
  cancellation cases, including the eight new interleavings). The control-plane source pin and its
  cleanliness checks were unchanged for these runs. The helper's existing regression case also rejects a
  changed retained session in an additional snapshot field.
- Removing the `dispatchPermitted !== false` check in the reader's fence envelope parser was **not** caught
  here. That check is covered by the Adea-side reader tests (`lead-product-reader-fence`,
  `lead-product-fence-envelope-*`); the joined path cannot produce that internal state.

## Limits

This is a source-level proof. It is not production qualification.

- The runtime edge is a recording stub that models one session per attempt and a lost start result. No real
  runtime, model provider or funding is exercised.
- The reader hop runs in-process through an injected `fetch`. There is no network, no TLS and no deployed
  service. Response authenticity on the real hop rests on TLS alone, and that is not tested here.
- The control plane is the pinned source composed by the test harness, not the production composition. CP
  composition, safe-resume, profile rollback and checkpoint conversion stay with the control-plane PRs
  (#1047, #1048, #1118) and are not exercised.
- Fenced lookup is refused by the control plane, so Adea cannot reconcile a `dispatch_pending` admission
  through lookup while fenced. It stays unresolved and fenced, which is the safe outcome but is not recovery.
- No control-plane read emits a runtime generation, so generation continuity is not asserted. Runtime
  execution, attempt, dispatch and session identity are asserted.
- The control plane's resume and publication policy entries have no consumer in this revision. Publication
  refusal is enforced by Adea. The control plane's publication-current service is not fence-aware.
- Archived admissions are covered above. Cancelling an archived admission's runtime is not possible; see the limits there.
