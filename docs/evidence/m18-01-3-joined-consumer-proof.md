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
checkout. Locally the run was the two joined test files together on a freshly migrated database: 21 pass, 0
fail (17 in this proof, 4 in `management-current`), 770 assertions. The 17 are the 11 proof tests plus 6
regressions for the command-binding comparison itself.

Mutation checks, all reverted afterwards:

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
- Archived-admission observation on the control plane was not re-verified.
