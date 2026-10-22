# Hosted Sim composed coverage evidence

Measured composition: base `9692ea03ad372a30da6b72823515e0f26d7b4882`,
including main `b9c89d9cc7042ddd5d9723a48f6c20d1f881bc40`, plus the selector,
boundary-test and pack-refusal changes published with this receipt.

`bun run test:coverage` ran **1,401 tests / 120 files / zero test failures**,
**exit 1**. Aggregate: **90.58% functions / 89.76% lines**. The failure is the
unchanged **80% per-file** goal, not an aggregate or test failure. The 21 deficient
files are listed below.

## Scope and enforcement

The selector adds the existing artifact-reference, desktop-permissions,
group-participation and management suites. The exact inventory assertion was
extended with the same four paths. Every previous input and flag remains. All
four modules now measure 100% functions and lines; no redundant contract tests
were added. Main's four tooling test improvements also measure 100%/100%.

The Sim pack CLI's existing refusal reporter is a named function with its body
unchanged. Tests exercise that reporting path and real successful/refused CLI
processes with 0/1 exits. The reporter's exit status and console spy are restored
in finally. The pack guard now measures 100% functions / 89.47% lines.

`bunfig.toml` retains `functions = 0.8` and `lines = 0.8`. Existing exclusions and
reporters are unchanged; no threshold reduction or new exclusion was added.
The real-runner regression requires a 50%-function/100%-line fixture to exit 1
and a 100%/100% fixture to exit 0. It passes with the actual repository settings
on pinned Bun 1.4.3. The controls and boundary tests also pass.

| File                                                               | Functions % | Lines % |
| ------------------------------------------------------------------ | ----------: | ------: |
| `apps/web/start/client-policy.mjs`                                 |        0.00 |   41.67 |
| `packages/auth/src/adapter.ts`                                     |       37.50 |   23.53 |
| `packages/db/src/agent-persona-policy.ts`                          |       66.67 |   84.44 |
| `packages/db/src/control-plane-identifiers.ts`                     |       50.00 |   36.84 |
| `packages/db/src/event-contract.ts`                                |        0.00 |   67.91 |
| `packages/db/src/lead-turn-rollback-policy.ts`                     |       60.00 |   74.12 |
| `packages/db/src/migration-snapshot-capture.ts`                    |       62.50 |   23.02 |
| `packages/db/src/migration-snapshot-legacy.ts`                     |       33.33 |   68.92 |
| `packages/db/src/task-submission-retention.ts`                     |       60.00 |   35.71 |
| `packages/db/src/transactions.ts`                                  |       44.44 |   23.68 |
| `packages/db/tests/fixtures/cutover-rehearsal.ts`                  |       58.33 |   57.97 |
| `packages/db/tests/fixtures/lead-production-factory-preflight.mjs` |       88.89 |   67.50 |
| `packages/db/tests/fixtures/lead-production-factory-process.mjs`   |       66.67 |   78.53 |
| `packages/types/src/index.ts`                                      |       60.00 |   87.93 |
| `scripts/capture-provisioning.mjs`                                 |       30.00 |   20.77 |
| `scripts/ci-lane-selection.mjs`                                    |       66.67 |   60.00 |
| `scripts/e2e-preparation.mjs`                                      |       80.00 |   51.43 |
| `scripts/orch-toolchain.mjs`                                       |       60.00 |   64.75 |
| `scripts/sign-desktop-update.mjs`                                  |       80.00 |   70.00 |
| `scripts/vite-plus-proof.mjs`                                      |       54.55 |   43.40 |

The existing `apps/web/test/cloudflare-config.test.ts` is also selected: its
eight tests measure the config source at 100% functions and lines. Every prior
input remains. A run with missing installed dependencies failed; frozen
installation restored those files, and the subsequent full run above has zero
test failures. This is not a passing receipt for the earlier damaged-input run.

## Ownership and separate private qualification

Root coordinated the tooling tests in merged PR #1456. This Sim owner retains
coverage configuration, its inventory/enforcement controls, desktop Sim payload
tests and joined-client implementation. Remaining shared gaps require
root-coordinated ownership; no source file in the remaining-gap inventory was edited here.

Private Agent Sim #111 at `341e616` independently passes its complete per-file
80% lane: 192 tests, 97.52% functions / 98.19% lines. Adea's remaining failures
must not be described as private #111 failures, or as passing Adea validation.
The earlier 31-file result is recorded in the chronological repair evidence;
this receipt supersedes its current-gap inventory after composition.

[Admitted exclusive test-file allocation](hosted-sim-test-ownership-2026-10-18.md)
records the read-only ownership check and root-admitted disjoint runtime/canvas
batches. Owners are restricted to their table test paths; no production-source,
configuration or held-work authority is implied.

## Reviewed-batch composition: passing per-file qualification

Coordinating root merged test-only #1458 at
`8204b573aed709be8352bd11845cc9c389550776`, then #1457 at
`62fe0a7b98ddd049f6e9efea6dd07d63d6624e81`. The Sim branch normally merged that
main at `55ec4e504832e1520c90fd2132b41b557d10742b`, preserving both batches and
the optional-view work. The test owners' paths were not edited during integration.

The canvas proposal adds exactly four inputs to the existing coverage command:
`packages/auth/tests/integration/adapter.test.ts`,
`apps/web/test/client-policy.test.ts`, and
`packages/types/tests/workspace-primitives.test.ts`. The two auth suites are
fake-backed despite their directory names. All prior selectors, plural
`lines`/`functions` thresholds, and exclusions remain unchanged.

The actual corrected lane passes: **1,553 tests across 125 files, 17,097
assertions, 98.66% functions / 97.90% lines; zero files below either 80% floor**.
The real-runner negative control and exact selector-boundary suite also pass
24 tests / 306 assertions; the control still rejects 50% function coverage with
100% lines and accepts 100%/100%. The earlier deficient-file inventory above is
historical and is fully resolved by this composition. No production source,
threshold, exclusion, or check was weakened to obtain this result.
