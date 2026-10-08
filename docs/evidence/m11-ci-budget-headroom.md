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
passed the workspace cases, then failed all 12 Linux ChatView captures. Each
hosted diff contains the same 36 significant pixels at the neutral status dot
introduced by #1155's shared `statusDotVariants`; the macOS ChatView baseline
already includes that dot. The subsequent #1157 and #1166 platform captures
landed on main. This candidate integrates main
`80f6c9689dd550790546c3e2e8bcc5b96998d06f` instead of duplicating their baselines;
its owned diff remains the two finite budgets, fixture seam, and this evidence.
Fresh validation of the integrated head remains required. An additional local
Linux diagnostic stopped at dev-server readiness and supplies no product test
result.
