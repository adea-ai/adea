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
bun run test:integration:control-plane-child      # child-allocation + allowance-omitted
bun run test:integration:control-plane-child-sdk  # installed-SDK consumer journey
```

The second command also needs `PI_FACTORY_MANIFEST`: a `pi-durable-candidate-artifacts/v1`
manifest produced by `node scripts/pack-pi-durable-candidate.mjs <empty dir outside the repo>` in
the same clean, built CP checkout (head = `source.json`). It is used only to verify identity; no
dependency is installed from it.

Files: `harness.mjs` (shared setup), `host.mjs` (CP side), `child-allocation.test.mjs` (stated
allowance), `allowance-omitted.test.mjs` (no allowance), `installed-sdk-child.test.mjs` and
`installed-packages.mjs` (installed SDK).

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

## Latest result (2026-10-14, CP main `7d36f9bb`)

The pin is CP main commit `7d36f9bb`, the squash merge of CP #1131, which adds one test-fixture
option (`childAllowanceSource`) on top of `dbd9438` (that includes #1123, the child allowance). The
merged tree is byte-identical in content to the reviewed PR head `c68a8577` (same source digest).
It is a source revision, not a published package release. Results on a CP tree built at exactly
this commit (`bun install --frozen-lockfile`, `bun run build`):

- `test:integration:control-plane-child`: 15 of 15 pass (12 stated-allowance, 3 omitted-allowance).
- `test:integration:control-plane-child-sdk`: 7 of 7 pass.

### How a lead profile states the allowance

The lead profile is an opaque pin on Adea's side (`profileId`, `profileVersion`, `profileRevision`).
The profile definition lives in CP's catalog, and an immutable, digest-pinned published profile
version states the allowance in `definition.executionConstraints.limits.childExecutions
.budgetAllowance`. CP's plan compiler composes that with the request's constraints (the smaller
stated allowance wins; a layer that states none has no opinion). Adea does not author, restate or
cache the number. The proof now covers the whole chain with the allowance on the profile only:

- the fixture publishes the profile version with the allowance and gives the request constraints
  none (`childAllowanceSource: 'profile'`);
- the compiled lead plan pins that exact profile version and digest, read back independently from
  CP's catalog, and its allowance equals the profile's;
- the lead's attempt (reserved by CP's production root admission) leaves exactly that allowance
  unreserved, and the first child is funded with all of it;
- when the profile states none (`'none'`), the plan omits it, the lead's attempt holds its whole
  envelope, no child is funded until the lead settles, and only the balance it releases funds
  children, with nothing capping outstanding child funding below what the parent has.

The pin-to-profile-version mapping is the fixture's `profiles.resolveImmutable` port (synthetic).

The pinned lead profile states `limits.childExecutions.budgetAllowance` (half the money ceiling,
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
| CP model selection, lead preparation and dispatch, root budget admission                                                            | Production CP code (main `7d36f9bb`)                                    |
| Child delegation service, transactional SQLite allocator, ledger cap, child budget admission (`DurableChildRuntimeBudgetAdmission`) | Production CP code                                                      |
| Authority checks (admitting tool call, workspace grant, product readiness)                                                          | Production CP checks over scripted account, scope and tool-policy ports |
| Child runtime                                                                                                                       | Synthetic recorder that dedupes by idempotency key                      |
| Lead and child spending that gets settled                                                                                           | Synthetic: scripted ledger charges through the real ledger              |
| Provider transport, account evidence, tool registry and policy, the admitted tool call                                              | Synthetic host ports                                                    |
| `CanonicalDelegationRuntimeBridge` wiring                                                                                           | Built by this host; no CP composition root builds it yet                |
| Lead plan: the child allowance, via the compiler and the pinned profile version                                                     | Production CP plan compiler and catalog (the allowance is profile-only) |
| Lead plan: every other limit, and the sibling count                                                                                 | CP test fixture inputs                                                  |
| Adea pin to CP profile version mapping                                                                                              | Synthetic fixture port (`profiles.resolveImmutable`)                    |
| Adea lead product, SDK port and the three SDK packages (installed-SDK journey)                                                      | Production Adea code; registry packages from Adea's own lockfile        |
| CP control API application, service authenticator and lead service (installed-SDK journey)                                          | Production CP code; the trust record and loopback listener are scripted |

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
- The lead plan's other limits and the sibling count are CP test fixture inputs. The allowance is
  not: it comes from the pinned profile version (see above). The profile version itself is a
  fixture-published system profile, not a production catalog entry, so what production lead
  profiles actually state is not proven here.

### Installed-SDK consumer journey

`installed-sdk-child.test.mjs` drives the lead the way the product does. Adea's
`createLeadTurnProduct` prepares and dispatches the real PostgreSQL-backed intent through the SDK
packages installed from Adea's own lockfile, over HTTP to CP's actual control API application and
production lead service (same composition as the stated-allowance journey). The test then has CP's
host allocate a child from that same running lead and start it.

Package identity is verified before any database connection: the candidate manifest's head, clean
tree and source digest, and the three archives' hashes; then, for `@adea-ai/sdk`,
`@adea-ai/contracts` and `@adea-ai/runtime-sdk`, that the package installed in Adea's dependency
graph (a registry install, with exact pins in `apps/web/package.json`) has every file byte-identical
to the archive built from the CP head, and the same `name`, `type`, `main`, `module`, `types`,
`exports` and `files`. At `7d36f9bb`: sdk 1.18.0 (20 files), runtime-sdk 1.15.1 (77 files) and
contracts 1.21.1 (77 files), all at the candidate's versions. Only `package.json` differs: the publish step rewrites
dependency ranges and adds empty dev/peer maps. No pin, lockfile or override is changed, and the
archives are never installed. All eight lead SDK methods and their schemas are present.

Passing: preparation through the SDK with zero physical sends and zero secret resolutions; every CP
product read arriving through Adea's signed reader; dispatch (`starting` or `running`) and a
`running` status carrying the execution and attempt; the allowance on the SDK-dispatched lead's plan
equal to the pinned profile version's (request layer states none) and equal to the hold-back;
the child funded with exactly the allowance and started once (retry starts nothing twice); a sibling
refused with `BUDGET_EXHAUSTED` after the lead settles; and the lead still `running` through the SDK
afterwards.

Limits: the public SDK has no child or allowance operation, so the child is allocated by CP's host
(the same production delegation service) against the SDK-dispatched execution, not by the SDK. The
lead never completes here (the provider port is held), so completion and timeline publication through
the SDK are not part of this journey; the earlier installed-production-factory proof covers them
(`docs/guides/pi-production-factory-consumer-proof.md`). Not live, not TLS, not a deployment.

### Still unproven

- CP #1123's PostgreSQL suites were run by the author on a scratch local database; this journey does
  not re-run them.
- This journey runs on the SQLite allocator. The PostgreSQL allocator and child admission are covered by CP's
  own PostgreSQL integration suites (CP #1123), not here.
- Live-provider qualification, and devices, deployments, restart or publication are not covered.

Run hygiene: the host is terminated if graceful cleanup stalls; its owned disposable directory is
removed only after the process is reaped. Adea's fixture workspace is archived and its temporary
session expires.

## Remaining dependencies

- Repin `source.json` to a published CP release once one carries #1123 and #1131 (CP main
  `7d36f9bb` is a source revision). Neither changed a published package's version, so the installed
  SDK checks above do not depend on it.
- Backend contract missing: nothing discloses to Adea whether a pinned lead profile version states
  a child allowance. The product evidence and SDK responses carry no allowance or child-budget
  field, so Adea cannot show (or gate on) the budget a lead can delegate, and cannot flag a lead
  pinned to a profile that states none (legacy, uncapped behavior). The UI must keep showing only
  backend-confirmed state; this needs CP to disclose the pinned profile version's stated allowance
  (or its absence) through the existing product/funding disclosure. Authoring and publishing the
  production lead profile definitions with a stated allowance is CP catalog work, not Adea's.
- Open design point from CP #1123 (CP-owned): whether a child's plan ceiling must fit within the
  parent's stated allowance.
- No CP composition root builds `CanonicalDelegationRuntimeBridge` or passes
  `DurableChildRuntimeBudgetAdmission`; that belongs to the owners of CP #1047 and #1048.
- Live-provider qualification, the Pi child process, and native tool-originated delegation
  (`delegate_child` from a real model call) over the installed SDK path.
- CP935's session/task/generation binding and preparation-target work remains
  separately owned. This proof does not modify those paths.

#1211 remains open; its UI and independent-session acceptance belong to their existing owners.
