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
run. The source revision in `source.json` includes CP #1041. The default test
lanes do not load this directory. This source proof does not replace the verified
public-package candidate manifest required for full #1211 acceptance.

The actual services exercised are Adea's canonical intent and audience reader,
its signed service verifier, CP model selection, production lead preparation,
current child authority, production child delegation and the transactional SQLite
child allocator. Account evidence, scope policy, the tool registry/policy and the
provider transport are explicit synthetic host ports. The fixture does not
discover credentials, import Home configuration or use a live provider.

The retained run at CP `c5387139f8aa20af498fa96f32fb24ca8248c5d4` passes signed
host-workspace denial, exact requested-role preparation without inference, and
location/current-payer refusal without fallback. The positive child allocation
check fails: the actual allocator's current-authority recheck does not return
within eight seconds. Its diagnostic records `allocator-authority-recheck`, zero
physical sends and zero secret resolutions. The host is terminated if graceful
cleanup stalls; its owned disposable directory is removed only after the process
is reaped. Adea's fixture workspace is archived and its temporary session expires.

## Diagnosis of the blocked allocation (2026-10-14)

The failure reproduces at the pinned CP revision and at CP `main` (`d632197`, release 1.96.0,
which includes #1111). Nothing in this directory was changed to obtain these readings.

- Where it stops: tracing the production child admission authority shows `assertCurrent` runs
  twice. The first run (the preflight, no reader) completes in about 100 ms. The second run is the
  allocator's recheck inside the SQLite allocation transaction (a reader is supplied). It reads the
  canonical request, then calls `product.resolveChildSelection`, and that call never returns.
- Why it is a production contract gap and not a fixture gap: the recheck re-resolves the child's
  model selection from the product (an HTTP read) and the role-selection services (which use the
  funding database handle) while the allocation transaction holds the provider's write lock.
  `createProductionLeadProductAuthority.resolveChildSelection` states that the canonical authority
  must call it before allocation and retain the selection in the admission receipt. The in-transaction
  `assertCurrent` does it again instead of comparing against the retained receipt.
- Evidence that this is the cause (diagnostic edit in a scratch CP copy only, not committed anywhere):
  when `assertCurrent` with a reader rechecks only the canonical current request against the receipt's
  authority revision, the recheck returns in about 30 ms and the allocation proceeds to its next stage.
- Next blocker after that, also observed only in the scratch copy: `BUDGET_EXHAUSTED` at
  `child-allocation`, with 0 microunits and 0 tokens available on the parent. The lead's funded
  attempt reserves the whole plan budget, so there is no headroom to reserve the child's half.
  Doubling the plan maxima in the fixture did not change this, so the fixture sizing alone does not
  explain it. Whether a parent lead should reserve its full plan budget, and how a child's reservation
  is carved out of it, is a Control Plane decision (CP #1041 owns child budget reservation).

Owners: the in-transaction recheck and the budget reservation rule are Control Plane changes. This
proof will pass its positive allocation only when CP lands them; it must not be changed to skip or
loosen either check.

## Remaining dependencies

- Resolve the CP current-authority recheck under the allocator transaction.
  The model-selection repository and canonical allocator currently share the
  fixture's SQLite provider. Re-entry through model readiness is a candidate
  cause, not a confirmed diagnosis. Do not bypass the recheck to obtain a green
  result.
- Verify the parent/child budget policy, separately recorded child funding and
  actual child-runtime admission after allocation completes. This run does not
  reach those boundaries.
- Produce and verify the updated public-package candidate manifest, then run
  the installed SDK consumer journey. This direct source proof makes no package,
  live-account, device, deployment, restart or publication qualification claim.
- CP935's session/task/generation binding and preparation-target work remains
  separately owned. This draft does not modify those paths.

The allocation failure is asserted as a failure, never skipped or counted as
passing. #1211 remains open; its UI and independent-session acceptance belong to
their existing owners.
