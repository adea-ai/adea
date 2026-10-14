# Joined backend evidence for Adea #1211

This opt-in source proof sends a real PostgreSQL-backed Adea lead intent through
the authenticated production product reader to the Control Plane production
factory. Lead and child model references come from its model-selection service
and are pinned on the immutable Adea intent. The Control Plane runs in a separate
process using its configured Bun runtime and compiler context.

Run after building Adea's DB dependencies and the pinned Control Plane factory
dependencies. Supply an existing isolated local PostgreSQL target at
`127.0.0.1:55432`, `ADEA_CONTROL_PLANE_SOURCE`, and the absolute
`PI_FACTORY_BUN` executable:

```sh
bun run test:integration:control-plane-child
```

Missing configuration, a different CP head, or a dirty CP source tree fails the
run. The source revision in `source.json` includes CP #1041, #1116 and the child allowance merged as CP #1123. The default test
lanes do not load this directory. This source proof does not replace the verified
public-package candidate manifest required for full #1211 acceptance.

The actual services exercised are Adea's canonical intent and audience reader,
its signed service verifier, CP model selection, production lead preparation,
current child authority, production child delegation and the transactional SQLite
child allocator. Account evidence, scope policy, the tool registry/policy and the
provider transport are explicit synthetic host ports. The fixture does not
discover credentials, import Home configuration or use a live provider.

## Latest result (2026-10-14, CP main `dff15411`)

The pin is CP main commit `dff15411`, the squash merge of CP #1123. It adds the explicit child
allowance designed for CP #1121 on top of the #1116 merge (`082c2c33`). It is a source revision,
not a published package release. Result: 11 of 11 pass, stable across three consecutive runs, on a
CP tree built at exactly this commit. The allowance code at `dff15411` is identical to the reviewed
PR head `cd3a1de7` (no diff in the allowance packages between them).

The fixture's lead plan states `limits.childExecutions.budgetAllowance` (half the money ceiling,
and one child context window of tokens). The lead's attempt reserves only what is left after that
allowance, so the child can be funded. The child plan states its own smaller allowance for its own
children; CP no longer compares it with the parent's. Nothing here bypasses or loosens a budget
check, and the child ceiling is still clamped to what the parent has available.

The child's runtime attempt is reserved by CP's production `DurableChildRuntimeBudgetAdmission`
(the bridge's `reserveBudget` seam), not by a reservation mirrored in this host. It checks the
delegation record, the allocator's opening receipt and the parent's funding reservation, then
reserves the child's funded budget less the allowance its own plan holds back.

### Production versus synthetic evidence

| Evidence                                                                                                                            | Source                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Adea intent, audience reader, signed service verifier, requested roles                                                              | Production Adea code over a real local PostgreSQL                       |
| CP model selection, lead preparation and dispatch, root budget admission                                                            | Production CP code (merged `dff15411`)                                  |
| Child delegation service, transactional SQLite allocator, ledger cap, child budget admission (`DurableChildRuntimeBudgetAdmission`) | Production CP code                                                      |
| Authority checks (admitting tool call, workspace grant, product readiness)                                                          | Production CP checks over scripted account, scope and tool-policy ports |
| Child runtime                                                                                                                       | Synthetic recorder that dedupes by idempotency key                      |
| Lead and child spending that gets settled                                                                                           | Synthetic: scripted ledger charges through the real ledger              |
| Provider transport, account evidence, tool registry and policy, the admitted tool call                                              | Synthetic host ports                                                    |
| `CanonicalDelegationRuntimeBridge` wiring                                                                                           | Built by this host; no CP composition root builds it yet                |
| Lead plan and sibling count                                                                                                         | CP test fixture inputs                                                  |

Assertions preserved from earlier rounds: authority (revoked grant, exhausted quota, before and
after allocation), budget (independent budgets, parent ceiling unchanged, exact reservations),
settlement (the allowance cases below) and retry (allocation, denial and child start add no rows
and no starts).

### Allowance limits exercised by this journey

Every allocation below goes through CP's real `delegate` service and transactional SQLite
allocator; the only scripted inputs are the spending amounts.

- Hold-back: after the lead's attempt reserved through production root admission, the lead has
  exactly its stated allowance unreserved. The first child is funded with all of it, leaving the
  parent with nothing available.
- Outstanding child funding and settled lead spending: the lead's usage reservation is then
  settled with scripted spending (1000 microunits, 10 tokens). The parent has balance available
  again, yet a sibling is refused with `BUDGET_EXHAUSTED` because the first child still holds the
  whole allowance. The refusal leaves no delegation, execution, attempt, budget or ledger row.
- Settled child spending: the first child settles scripted spending (2000 microunits, 20 tokens)
  and its budget is finalized. A sibling is then funded with exactly the allowance minus what the
  child charged, although the parent has far more available.
- Cancelled parent: the lead's attempt and execution are cancelled through the canonical
  lifecycle, and a further child is refused with no budget, delegation or ledger effect. The
  delegation service refuses it first (`DELEGATION_STATE_CONFLICT`, parent no longer running). The
  allocator's own fence (`CHILD_ADMISSION_DENIED`) and the ledger cap with the usage reservation
  settled but the attempt still running are proven in CP's tests (`tests/child-runtime-budget-admission.test.mjs`,
  `packages/usage-ledger`, `packages/database`), not here.

Passing, in addition:

- signed host-workspace denial, exact requested-role preparation without inference, and
  location/current-payer refusal without fallback;
- positive allocation: the child reaches CP's real `delegate` -> `dispatchChild` ->
  `CanonicalDelegationRuntimeBridge.startChild` path, which re-reads authority, reserves the child's
  attempt through the production admission and starts the child runtime once;
- independent budgets: the parent ceiling never changes, the parent holds exactly the child's
  ceiling as a reservation, nothing is spent, and the child's own spending and reservations never
  change the parent's attempt envelope;
- a revoked workspace grant (`CHILD_AUTHORITY_EXPANSION`) and an exhausted account quota
  (`CHILD_ADMISSION_DENIED`) each admit no child: no execution, attempt, budget or ledger row,
  parent budget unchanged, zero child-runtime reservations or starts, zero provider sends and zero
  secret resolutions;
- authority revoked or quota exhausted after allocation but before start: zero dispatch, and the
  child starts exactly once after authority returns;
- retries: a retried allocation, a retried denied allocation and a retried child start leave the
  canonical counts, both ledgers and the runtime start count identical.

### Synthetic here

- The child runtime is a recorder that dedupes by idempotency key. It is not a live Pi child
  process, so this proves admission and retry behaviour, not live-provider qualification.
- Lead and child spending is scripted ledger charges written by the host. No model request, tool
  charge or provider ever produced it, so cost accounting from real usage is not exercised.
- The provider transport, account evidence, scope policy, the tool registry/policy and the admitted
  tool call are explicit host ports. No credentials, live accounts, devices, deployments or
  packages are used.
- The bridge is built by this host. No CP production composition root builds
  `CanonicalDelegationRuntimeBridge` or passes `DurableChildRuntimeBudgetAdmission`; that wiring
  belongs to the owners of CP #1047 and #1048 and the contract is in CP #1123.
- The lead's plan comes from CP's test fixture (`budgetAllowance` and sibling count are fixture
  inputs). How Adea lead profiles state the allowance is not implemented or proven.

### Still unproven

- CP #1123's PostgreSQL suites were run by the author on a scratch local database; this journey does
  not re-run them.
- This journey runs on the SQLite allocator. The PostgreSQL allocator and child admission are covered by CP's
  own PostgreSQL integration suites (CP #1123), not here.
- The installed-SDK consumer journey, the updated public-package candidate manifest, live-provider
  qualification, and devices, deployments, restart or publication are not covered.

Run hygiene: the host is terminated if graceful cleanup stalls; its owned disposable directory is
removed only after the process is reaped. Adea's fixture workspace is archived and its temporary
session expires.

## Remaining dependencies

- Open design points from CP #1123: whether a child's plan ceiling must fit within the parent's
  stated allowance, and how lead profiles state the allowance on the Adea side.
- Repin to a published CP release once one carries #1123.
- Produce and verify the updated public-package candidate manifest, then run
  the installed SDK consumer journey. This direct source proof makes no package,
  live-account, device, deployment, restart or publication qualification claim.
- CP935's session/task/generation binding and preparation-target work remains
  separately owned. This proof does not modify those paths.

#1211 remains open; its UI and independent-session acceptance belong to their existing owners.
