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

## Child allowance boundary (CP draft #1136)

CP #1136 adds an optional `childAllowance` (`stated` with USD microunits and tokens, or
`not_stated`) to the lead `prepare` response. The preparation schema in the SDK is strict, so the
SDK that accepts the field must be released and Adea bumped to it **before** the CP change is
deployed. `child-allowance-boundary.test.mjs` prepares and dispatches the lead through the
installed SDK over HTTP to CP's control API at the #1136 head, for a profile that states an
allowance and one that states none.

The expectation is explicit and required, so a broken SDK cannot pass by being measured and then
excused. `PI_FACTORY_EXPECT_SDK` and `PI_FACTORY_INSTALL` have no defaults:

- `accepts`: the measured acceptance must be true, prepare must return `prepared`, the typed field
  must equal the pinned profile version's statement (or `not_stated`), a response without the field
  must still parse, a half statement must not, and **dispatch must run the lead**. Nothing is
  skipped.
- `rejects`: the measured acceptance must be false and the turn must fail closed (`blocked` /
  `RUNTIME_UNAVAILABLE`, no preparation reference, no dispatch, 0 physical sends). This is the
  negative control for a registry SDK that predates the field.
- `candidate-overlay` and the post-bump `registry` install may only be expected to `accept`; the
  suite refuses to start otherwise.

| `PI_FACTORY_INSTALL`           | What is installed                                                                                                | Allowed expectation                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `registry`                     | Adea's lockfile SDK, checked byte-identical to the candidate (every file but `package.json`): the post-bump gate | `accepts`                                    |
| `registry-predating-candidate` | Adea's lockfile SDK, expected to differ from the candidate; the differing files are printed                      | `rejects`, or `accepts` to prove the failure |
| `candidate-overlay`            | The packed candidate archives in a throwaway checkout (pre-release evidence only)                                | `accepts`                                    |

```sh
# Pin to the #1136 head; the manifest comes from `node scripts/pack-pi-durable-candidate.mjs <dir>`
# in the clean, built CP checkout at that head.
DATABASE_URL=... ADEA_CONTROL_PLANE_SOURCE=<cp at d0cc27c3> PI_FACTORY_BUN=<bun 1.4.2> \
PI_FACTORY_MANIFEST=<candidate>/manifest.json \
  bun run test:integration:control-plane-child-allowance            # registry + accepts: the post-bump gate
  bun run test:integration:control-plane-child-allowance-predating  # lockfile SDK + rejects: negative control
```

The first script is the gate that must pass after the SDK release and the Adea bump, and it fails
until then (today the lockfile SDK is not byte-identical to the candidate, so it stops at the
identity check). Local results at `d0cc27c3`, 2026-10-14:

| Run                                                                                                                                    | Expectation | Result                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lockfile SDK (sdk 1.18.0, runtime-sdk 1.15.1), `-predating` script                                                                     | `rejects`   | 8 of 8 pass: `blocked` / `RUNTIME_UNAVAILABLE`; seven files differ (runtime-sdk `dist/pi-durable-lead.*`, sdk `dist/operations.d.ts*`, `openapi/control-plane.v3.json`) |
| packed candidate archives, throwaway checkout (`candidate-overlay`)                                                                    | `accepts`   | 8 of 8 pass, twice: `prepared`, typed field equal to the profile statement, dispatch runs                                                                               |
| **negative** lockfile SDK, `registry-predating-candidate`                                                                              | `accepts`   | **fails**: the acceptance assertion, the typed-field test and the dispatch test fail in both modes                                                                      |
| **negative** broken candidate: candidate whose runtime-sdk lacks the field, with a manifest that matches it so package identity passes | `accepts`   | **fails** at the same assertions with `installedAccepts: false` (the earlier either-outcome version would have passed)                                                  |
| **negative** overlay, `rejects`; or no expectation / no install kind                                                                   | -           | the suite refuses to start (`CANDIDATE_OR_RELEASED_SDK_MUST_BE_EXPECTED_TO_ACCEPT`, `PI_FACTORY_EXPECT_SDK_REQUIRED`)                                                   |

The overlay is pre-release evidence for a change no published package carries. It is not evidence
about Adea's lockfile or a release: the candidate keeps the published version numbers (sdk 1.18.0,
runtime-sdk 1.15.1), which a release will change, and Adea's own checks (clean install, lockfile,
typecheck, unit lanes) have not run against it. The qualification is complete only when
`test:integration:control-plane-child-allowance` passes on the default registry install after the
bump.

## Lead-to-child journey (#1173)

One workspace lead, one direct topic, one pinned BYO selection, one real Pi child and one logical
outcome, through Adea's production lead product and the installed SDK, over HTTP to CP's actual
control API, against **CP main `0a453d8`**, the squash merge of CP #1134 (reviewed head
`421f225d`; `source-journey.json`). It carries the production child bridge builder and
`PiChildTerminalSettlement` (CP #1137). It is a merged source revision, not a published release.
The installed SDK comes from Adea's lockfile (sdk 1.18.0, runtime-sdk 1.15.1, contracts 1.21.1) and
is compared with the packages that revision builds (sdk 1.18.1, runtime-sdk 1.15.1, contracts
1.21.3) before any database connection is opened. `runtime-sdk`, which holds the lead contract, is
byte-identical. Twelve files differ, and `declaredDrift` in `journey-support.mjs` pins each one to
its reviewed installed and built sha256 (install kind `registry-declared-drift`); a different
content in either file, an undeclared difference, or a declared file that stops differing fails the
run (checked with a negative control).

| Files                                                                                                                                 | Change in the CP build                                                            | Import-path impact                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| contracts `dist/graphs.js` (+ `.d.ts`, `control-api.d.ts`, maps), sdk `dist/operations.d.ts`, `openapi/control-plane.v3.json` (+ map) | CP #1149/#1150: an optional `digestVersion: 'canonical-json-v1'` on graph digests | Strictly additive and optional. Evaluated when contracts loads, never parsed by the lead operations, which carry no graph digest. Types and OpenAPI text are not executed.                                                                                                                                                                                                                                                  |
| contracts `dist/canonical-json.js` (+ maps)                                                                                           | Loop-based rewrite of `canonicalJsonStringify`, same canonical form               | Evaluated when contracts loads and used by runtime-sdk modules (health, eligibility, models, sessions, ...), not by Adea's lead operations (Adea hashes payloads with its own `canonicalJson`). `journey-drift.test.mjs` runs both implementations on edge values, 2,000 seeded random documents and code-point ordering and requires identical output and identical thrown errors; a `localeCompare` mutation is detected. |

This is not an Adea-lockfile-equals-CP claim and the release-parity gap stays open: a published
SDK/contracts release plus an Adea bump would remove the table.

```sh
# manifest: node scripts/pack-pi-durable-candidate.mjs <dir> in a clean, built CP checkout at 0a453d8
ADEA_CONTROL_PLANE_SOURCE=<CP checkout at 0a453d8> PI_FACTORY_BUN=<abs bun> \
PI_FACTORY_MANIFEST=<dir>/manifest.json DATABASE_URL=<local postgres> \
  bun run test:integration:control-plane-journey
```

Architecture: Adea's real PostgreSQL; a CP host process (`host-journey.mjs`: CP's production Pi lead
factory with the governed `delegate_child` tool, a scripted provider transport with named gates, no
live provider and no credential); and Adea's operations as separate OS processes
(`journey-driver.ts`) that build the product from nothing but PostgreSQL and the CP address. A fault
named in `JOURNEY_FAULT` SIGKILLs the driver at one boundary, so the next run is a real Adea process
restart. CP's side is reopened **in-process only** (`reopen`): CP's fixture cannot reopen its
composition in a new OS process, so CP process-restart recovery is **not** claimed.

| File                             | Proves                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `journey.test.mjs` (6)           | An accepted message, snapshot, status and progress start nothing. Prepare discloses the payer with no inference and replays as the same preparation. Dispatch runs the lead once; the child is allocated, funded and started once. The exact answer bytes are published once with the identity chain intent, execution, attempt, native session and child. Retries and a CP reopen change no durable row. An ordinary direct message creates no intent or CP work. |
| `journey-recovery.test.mjs` (6)  | Prepare reply lost (SIGKILL); dispatch accepted by CP but lost to Adea, recovered by lookup with no second dispatch; terminal receipt lost; killed inside the publication transaction (nothing published); killed after commit (same message, same digest on every retry). Counters at the end.                                                                                                                                                                    |
| `journey-drift.test.mjs` (3)     | `canonicalJsonStringify` in the installed contracts and in the CP build agree on edge values, seeded random documents and ordering.                                                                                                                                                                                                                                                                                                                                |
| `journey-authority.test.mjs` (8) | A lead stop retried from a new process is one CP stop, does not cancel the child, and an acknowledgement is not termination. CP's publication authority withdrawn: result withheld, then published once when restored. A stop after completion is refused and changes nothing. A revoked audience gets no result and no projection.                                                                                                                                |

Results at the final head (Bun 1.4.2, Node 22.22.0; scripted provider, synthetic accounts):

- 23 pass, 0 fail at CP `0a453d8` (`bun run test:integration:control-plane-journey`).
- Counters at the end of the recovery journey: CP canonical commands 1, executions 2 (lead, child),
  attempts 2, budgets 2; physical provider sends 3 (lead 2, child 1); child starts 1, executor
  calls 1, funding writes 1, one reservation `runtime-attempt:<childAttempt>`; one
  `delegation.completed` publication (revision 1); one intent, one published Adea message.

### Defect found and fixed in Adea

CP binds a command's idempotency key to a digest that includes the envelope `issuedAt`. Adea minted
a fresh `issuedAt` for every attempt, so any retry of prepare, dispatch or cancel after a lost reply
(or from a new process) was refused as `PI_LEAD_COMMAND_CONFLICT`, surfacing as
`RUNTIME_UNAVAILABLE`. Only the unit fakes and in-process replays ever saw success. Adea now sends the
intent's immutable creation time as `issuedAt` for prepare and dispatch, and the stored
`cancel_requested_at` for cancel (`LeadRuntimeAuthority.admittedAt`, `commandEnvelope({ issuedAt })`).
CP is unchanged and accepted the older instants. Failing-first unit tests are in
`lead-turn-composition.test.ts` and `lead-turn-runtime.test.ts`; the joined recovery and stop suites
exercise it with real process restarts.

### Behavior the proof recorded (not designed here)

- The lead finishes after it _starts_ the child; the child's outcome is a separate record. The lead's
  answer text does not carry it.
- Lead stop never cascades. With the lead running and the child's provider request in flight, a lead
  stop left the child `running` and CP's delegation record not terminal (`dispatched` or `running`, depending on when CP's progress scan last ran). CP holds a lead stop open
  while the provider call is in flight, so the first reply can time out; the retry returns
  `cancelling`.
- An acknowledged stop is not termination: the lead was still `cancelling` after its provider call
  was released.
- Child cancellation exists only as CP's host-side `cancelChildren` (not on the public lead contract
  or in Adea). The delegation record became `cancelled` while the child's native session was still
  `running`, and became `unknown` once its request ended.
- A stop pressed after the lead completed is refused by CP (`RUNTIME_UNAVAILABLE`); the published
  answer and the child are untouched. A stop requested before the answer exists does not by itself
  suppress a later published answer if CP reports the lead completed.
- A member removed from the audience is refused outright on every read and retry (no projection, no
  result); a result whose CP publication authority was withdrawn is withheld with
  `PUBLICATION_WITHHELD` and published once, exact bytes, after it is restored.
- CP settles the child on its own recovery interval after the terminal states: the retained child
  cost state moves `reserved` to `settled` (revision 1 to 4) and the usage ledger grows (14 to 21
  rows) roughly ten to twenty seconds later. Counter and replay comparisons therefore wait for the
  terminal accounting receipt (`costState: settled`, delegation `completed`) and then assert that
  the complete ledger, usage rows included, and the cost-state revision are unchanged by scans, a
  CP reopen, retried commands, crashes and refused reads. Only the transient "no new CP work"
  snapshots taken while the child is in flight leave usage rows out.

### Not proved (acceptance stays open on #1173)

- **No public child interface.** CP's public lead contract (prepare, dispatch, lookup, status,
  progress, cancel) has no child status, child outcome, child cancel or approval operation. Adea
  therefore cannot show or publish the child's logical outcome, cancel a child, or surface an
  approval, and these states are not drawn (see the changed-views note in
  `design-consolidation/changed-views-1173-lead-child-states.md`). The child result was checked from
  CP's own records only.
- **CP process restart.** CP is reopened in-process only.
- **Revocation inside the publication transaction.** The audience fault revokes before Adea's next
  audience check, so Adea refuses before the transaction; the in-transaction recheck is covered by
  the existing publication tests, not by a process fault here.
- **Handoff target / one RuntimeSession across Dev and Chat.** The harness admits no handoff target,
  so the shared-RuntimeSession path is not exercised by this journey.
- **Released packages.** The CP revision is merged but unreleased, and Adea's lockfile packages
  differ from its build by the declared drift above; this is not evidence about a release or a live
  provider.

## Remaining dependencies

- Repin `source.json` to a published CP release once one carries #1123 and #1131 (CP main
  `7d36f9bb` is a source revision). Neither changed a published package's version, so the installed
  SDK checks above do not depend on it.
- Backend contract: CP draft #1136 (head `d0cc27c3`) adds an optional `childAllowance` to the lead
  `prepare` response. See "Child allowance boundary" above. This proof stays pinned to the merged
  `7d36f9bb`, which predates the field. Adea has not shipped any display of it: that needs a
  published SDK, a persistence change (the prepare record has no JSON column), a line beside the
  payer confirmation and the canvas update. Authoring and publishing production lead profile
  definitions with a stated allowance is CP catalog work, not Adea's.
- Open design point from CP #1123 (CP-owned): whether a child's plan ceiling must fit within the
  parent's stated allowance.
- No CP composition root builds `CanonicalDelegationRuntimeBridge` or passes
  `DurableChildRuntimeBudgetAdmission`; that belongs to the owners of CP #1047 and #1048.
- Live-provider qualification, the Pi child process, and native tool-originated delegation
  (`delegate_child` from a real model call) over the installed SDK path.
- CP935's session/task/generation binding and preparation-target work remains
  separately owned. This proof does not modify those paths.

#1211 remains open; its UI and independent-session acceptance belong to their existing owners.
