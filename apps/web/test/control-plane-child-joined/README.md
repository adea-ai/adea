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
run. The source revision in `source.json` includes CP #1041 and #1116. The default test
lanes do not load this directory. This source proof does not replace the verified
public-package candidate manifest required for full #1211 acceptance.

The actual services exercised are Adea's canonical intent and audience reader,
its signed service verifier, CP model selection, production lead preparation,
current child authority, production child delegation and the transactional SQLite
child allocator. Account evidence, scope policy, the tool registry/policy and the
provider transport are explicit synthetic host ports. The fixture does not
discover credentials, import Home configuration or use a live provider.

## Latest result (2026-10-14, CP `082c2c33`)

The pin is the CP #1116 merge (`082c2c33`, release 1.96.2), which fences the allocator's
current-authority recheck. The `allocator-authority-recheck` hang recorded earlier no longer
reproduces: the in-transaction recheck returns and allocation reaches child funding.

Passing (5 of 8):

- signed host-workspace denial, exact requested-role preparation without inference, and
  location/current-payer refusal without fallback;
- a revoked workspace grant (`CHILD_AUTHORITY_EXPANSION`) and an exhausted account quota
  (`CHILD_ADMISSION_DENIED`) each admit no child: no execution, attempt, budget or ledger row,
  parent budget unchanged, zero child-runtime reservations or starts, zero provider sends and
  zero secret resolutions;
- a retried denied allocation leaves the canonical counts and both ledgers identical.

Failing, and expected to keep failing until Control Plane changes (3 of 8):

- positive allocation: `BUDGET_EXHAUSTED` at `child-allocation` with 0 microunits and 0 tokens
  available, `persistedChild` false and zero provider sends. The cause is a Control Plane rule,
  not this fixture: `DurableRuntimeBudgetAdmission` reserves the lead attempt's entire remaining
  allowance, and `DurableUsageLedger.openBudget` funds a child only from the parent's unreserved
  balance. Doubling the plan maxima does not help. Tracked as CP #1121 with three design options;
  related CP #1018 and #931. Nothing here bypasses or loosens that check.
- the two tests after it (post-allocation authority denial and child-runtime admission) cannot
  run until a child exists, so they fail on `expect(allocation?.ok)`, never skip.

Those later assertions are written but have not been exercised end to end. They use CP's own
`CanonicalDelegationRuntimeBridge`: authority is re-read from the admitting tool call and the
current account/product/readiness resolution; budget is the child's own ledger reservation of its
whole ceiling under `runtime-attempt:<childAttemptId>`, as in CP's child-budget-admission test.
The runtime port is a synthetic recorder that dedupes by idempotency key. It is not a live Pi
child process, so a pass would prove admission and retry behaviour, not live-provider qualification.
They may need adjusting once CP funds the child.

Independence is asserted as: the parent ceiling never changes, the parent holds exactly the
child's ceiling as a reservation, nothing is spent, and starting the child changes only the
child's ledger, never the parent's.

Run hygiene: the host is terminated if graceful cleanup stalls; its owned disposable directory is
removed only after the process is reaped. Adea's fixture workspace is archived and its temporary
session expires.

## Remaining dependencies

- Control Plane must decide how a child is funded when the lead holds the whole allowance
  (CP #1121). This proof turns green for allocation only when that lands.
- Verify the post-allocation assertions above against the real funded child.
- Produce and verify the updated public-package candidate manifest, then run
  the installed SDK consumer journey. This direct source proof makes no package,
  live-account, device, deployment, restart or publication qualification claim.
- CP935's session/task/generation binding and preparation-target work remains
  separately owned. This draft does not modify those paths.

The allocation failure is asserted as a failure, never skipped or counted as
passing. #1211 remains open; its UI and independent-session acceptance belong to
their existing owners.
