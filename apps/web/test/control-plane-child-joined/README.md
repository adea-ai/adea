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
run. The source revision in `source.json` includes CP #1041, #1116 and the unmerged allowance of CP #1123. The default test
lanes do not load this directory. This source proof does not replace the verified
public-package candidate manifest required for full #1211 acceptance.

The actual services exercised are Adea's canonical intent and audience reader,
its signed service verifier, CP model selection, production lead preparation,
current child authority, production child delegation and the transactional SQLite
child allocator. Account evidence, scope policy, the tool registry/policy and the
provider transport are explicit synthetic host ports. The fixture does not
discover credentials, import Home configuration or use a live provider.

## Latest result (2026-10-14, CP draft head `8d8843b4`)

The pin is the head of CP draft PR #1123 (`8d8843b4`), which adds the explicit child allowance
designed for CP #1121 on top of the #1116 merge (`082c2c33`). That PR is unmerged, so this proof
pins an unreleased CP revision. Result: 8 of 8 pass, stable across three consecutive runs.

The fixture's lead plan states `limits.childExecutions.budgetAllowance` (half the money ceiling,
and one child context window of tokens). The lead's attempt reserves only what is left after that
allowance, so the child can be funded. The child plan states its own smaller allowance for its own
children; CP no longer compares it with the parent's. Nothing here bypasses or loosens a budget
check, and the child ceiling is still clamped to what the parent has available.

The child's runtime attempt is reserved by CP's production `DurableChildRuntimeBudgetAdmission`
(the bridge's `reserveBudget` seam), not by a reservation mirrored in this host. It checks the
delegation record, the allocator's opening receipt and the parent's funding reservation, then
reserves the child's funded budget less the allowance its own plan holds back. The allowance is
also a cap at allocation, so a child is never funded beyond it even if the lead's reservation has
settled; that ordering is proven in CP's own tests, not by this journey, which keeps the lead
running.

Passing:

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

Caveats, so the result is not read as more than it is:

- The runtime port is a synthetic recorder that dedupes by idempotency key. It is not a live Pi
  child process, so this proves admission and retry behaviour, not live-provider qualification.
- The lead's attempt is reserved by CP's production root `DurableRuntimeBudgetAdmission` through the
  factory, and the delegated child's by `DurableChildRuntimeBudgetAdmission`; neither reservation
  is written by this host. The child's own runtime, however, is the synthetic recorder above.
- CP #1123 has not been merged, and neither its PostgreSQL integration suites nor its CI have run.
- Account evidence, scope policy, the tool registry/policy and the provider transport are explicit
  synthetic host ports. No credentials, live accounts, devices, deployments or packages are used.

Run hygiene: the host is terminated if graceful cleanup stalls; its owned disposable directory is
removed only after the process is reaped. Adea's fixture workspace is archived and its temporary
session expires.

## Remaining dependencies

- Merge CP #1123 (or an agreed alternative funding design), then repin this proof to the merged
  revision. Two design points are open on that PR: whether a child's plan ceiling must fit within
  the parent's stated allowance, and how lead profiles state the allowance on the Adea side.
- Produce and verify the updated public-package candidate manifest, then run
  the installed SDK consumer journey. This direct source proof makes no package,
  live-account, device, deployment, restart or publication qualification claim.
- CP935's session/task/generation binding and preparation-target work remains
  separately owned. This draft does not modify those paths.

#1211 remains open; its UI and independent-session acceptance belong to their existing owners.
