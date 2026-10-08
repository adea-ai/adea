# M11 candidate CI budget repair

This repairs validation capacity; it does not establish M11 execution or
certification acceptance. No application behavior, database schema, production
credentials, test selection, screenshot tolerance, or per-test deadline changes.

## Virtual route

Cold Linux/amd64 builds used Node 24.21.0 and Bun 1.4.0 with frozen dependency
installation. The main comparison and event candidate used the same container
and checkout path.

| Source                                                        | Virtual raw bytes | Virtual gzip bytes | Files |
| ------------------------------------------------------------- | ----------------: | -----------------: | ----: |
| Main `35ba2d7da1d607d5cf4dcd0a2cac902c7595219b`, before #1155 |           116,446 |             39,193 |    16 |
| Main `25264860b403f5f400ab9b4c933f06a15524cba3`               |           116,479 |             39,202 |    16 |
| Event candidate `0f1163aef5d00dfab01b44f7eb89efbfdb9ee5aa`    |           116,479 |             39,202 |    16 |

All 157 browser JavaScript files are byte-identical between the latter two
builds. The event decoder adds no browser bytes. The shared UI migration in
#1155 adds 33 raw / 9 gzip bytes to Virtual; the prior build already had only
seven gzip bytes of headroom. The candidate reproduces the [hosted failure](https://github.com/adea-ai/adea/actions/runs/37698982644/job/113057596224)
exactly: 39,202 exceeds the 39,200-byte limit.

The Virtual caps move from 114 KiB raw / 39,200 gzip bytes to 116 KiB raw /
39 KiB gzip: approximately 2% headroom, matching the startup/Chat approach in
#1149. Aggregate, startup, other route, file-count and module-attribution gates
retain their limits. A 5% increase over the measured Virtual output still
exceeds either new independent byte cap. The [performance ADR](../decisions/0010-performance-budgets-and-gates.md#go-no-go-gates)
requires this attribution and retained aggregate enforcement.

## Managed Neon preview integration

Retention candidate `0ef675f96bf53c9f24fcd2ea7b30799cc29e25bf` [run 37700345381](https://github.com/adea-ai/adea/actions/runs/37700345381/job/113062064906)
verified 40 applied migrations, database role health, and passing application
integration cases before cancellation. GitHub's annotation states that the job
exceeded its maximum execution time of 20 minutes. The full integration suite
did not finish; cancellation is not a pass.

The preview migration/integration job receives a finite 35-minute window for
cloud round trips. It retains migration replay, transaction coverage, role
health checks, the complete integration command, and existing test deadlines.
Setup and cleanup job limits, permissions, preview isolation and lifecycle
triggers are unchanged. A successful hosted run at the new candidate head is
still required before merge; this source repair is not that receipt.

## Composition fixture isolation

Full local unit validation also reproduced the existing `#424: without a bound
engine` composition test's five-second timeout, including when run alone.
Its owned-process listing passed, but the snapshot then invoked the real
macOS machine inventory: the fixture already scripted its other OS seams,
but omitted `runResourceCommand`. Several individually bounded `ps`/`lsof`
observations could outlast the entire test deadline.

The composition fixture now supplies a completed, empty observation through
that existing injection seam. Production machine inventory and its command
bounds are unchanged. Dedicated machine-resource tests retain the observation,
identity, output-bound and stop-authorization coverage. The composition test
keeps its original timeout and resource/stop assertions; this is fixture
isolation, not a change to application resource behavior.

## First hosted candidate and current-main integration

Candidate `5e817ffa611e383032e22710a7cc3cd359bad9a6` passed the
[hosted bundle check](https://github.com/adea-ai/adea/actions/runs/37705244741)
and [Neon preview job](https://github.com/adea-ai/adea/actions/runs/37705244770/job/113077976351).
The preview verified 42 migrations and completed 111 integration tests / 1,827
assertions with no failures. This is the CI repair candidate's receipt; it does
not exercise the retention operator candidate's additional cases or establish
M11 acceptance.

Its [visual job](https://github.com/adea-ai/adea/actions/runs/37705244749/job/113077944201)
selected ChatView by the lane's PR-parity policy and failed all 12 Linux captures. Each
hosted diff contains the same 36 significant pixels at the neutral status dot
introduced by #1155's shared `statusDotVariants`; the macOS ChatView baseline
already includes that dot. The subsequent #1157 and #1166 platform captures
landed on main. This candidate integrates main
`5ab5ce433248a7c39b2913514b7639038c669d5c`, including #1167's conversation
composition and Chat budget, #1169's settings/CSS cleanup, and #1163's reviewed
Darwin captures. Its owned diff remains the two finite budgets, isolated test
fixtures, and this evidence.
Fresh validation of the integrated head remains required. An additional local
Linux diagnostic stopped at dev-server readiness and supplies no product test
result.

At the preceding `80f6c9689dd550790546c3e2e8bcc5b96998d06f` integration,
build, lint, typecheck, formatting, focused boundary tests, root coverage
(302 tests / 7,139 assertions), and web tests (309 / 1,350) passed. The full
local default suite failed the unchanged navigation scale case's 100 ms gate;
serial execution passed that gate in 28 ms but hit four unchanged desktop
Git fixture five-second deadlines. All four Git cases passed individually
with their original deadlines. These isolated passes do not make the failed
aggregate pass. Current-head hosted default-concurrency validation is still
required; no timing assertion or deadline has been relaxed.

## Global nonce-pruning fixture

Candidate `4fddad36519d3482803d548b03d5f24fcb1fcef9` completed the
[Neon preview job](https://github.com/adea-ai/adea/actions/runs/37712023080/job/113099884204)
within the 35-minute window: 42 migrations verified and 111 integration cases
completed in 1,182.21 seconds, with 110 passing and one failing. The failure
was the expired target row remaining in the bounded nonce cleanup test. Its
subsequent live-proof assertion was not reached; the log does not demonstrate
deletion of a live proof.

The production pruner selects the oldest eligible row globally with limit 1.
Earlier fixtures retain request rows that can expire during cloud round trips;
another older eligible row can consume the deletion. The fixture now seeds a
competing expired row and gives its target a database-clock expiry older than
every existing request. It checks the returned deletion count and surviving
competitor, then removes only that fixture competitor before the original
live-proof assertion. Production ordering, proof/rate windows, batch limits,
test deadlines and original assertions remain unchanged.

An isolated PostgreSQL 16.15 reproduction with the competing row and original
timestamps failed the exact target-deletion assertion (0 passing / 1 failing).
The corrected fixture passed (1 test / 5 assertions). This local PostgreSQL
version also completed the root `bun run test:integration` command: database
role health, 42 migration verification/replay, and 111 tests / 1,829 assertions
passed. These local receipts are supplementary; fresh hosted Neon qualification
remains required.
Owned Docker fixtures stalled before database startup and ran no tests; their
recorded containers, networks and volumes were removed. The native fixtures
use separate clusters and ports, leaving the shared local database untouched.
