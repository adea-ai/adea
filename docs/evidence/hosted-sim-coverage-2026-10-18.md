# Hosted Sim composed coverage evidence

Measured composition: base `596c4f1c2a8150606411ff074868cdc148bdfd45`,
including main `750e5c1f90d9f626a7b34340695a0fc2a179c926`, plus the selector,
boundary-test and pack-refusal changes published with this receipt.

`bun run test:coverage` ran **1,393 tests / 119 files / zero test failures**,
**exit 1**. Aggregate: **90.24% functions / 89.30% lines**. The failure is the
unchanged **80% per-file** goal, not an aggregate or test failure. The 22 deficient
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
| `apps/web/cloudflare.config.ts`                                    |       60.00 |   45.95 |
| `apps/web/start/client-policy.mjs`                                 |        0.00 |   41.67 |
| `packages/auth/src/adapter.ts`                                     |       37.50 |   23.53 |
| `packages/auth/src/neon-driver.ts`                                 |       66.67 |   50.00 |
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
