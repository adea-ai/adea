# Admitted remaining coverage test ownership

Base: `9692ea03ad372a30da6b72823515e0f26d7b4882`, including reviewed main
`b9c89d9cc7042ddd5d9723a48f6c20d1f881bc40`. Root admitted the disjoint Runtime and Canvas tables below. The existing
runtime task owns only the eleven Runtime test paths; the existing canvas task
owns only the eleven Canvas test paths. Both scopes are test-only.

## Read-only ownership evidence

All proposed existing test paths were clean across 33 registered Adea worktrees;
no matching Fleet task claimed these exact paths. The existing runtime and canvas
sessions were idle when inspected. A clean worktree alone does not release
ownership: the inventory was read-only. Root subsequently admitted both bounded test-only
batches and coordinated their owners. This Sim task sent no assignments and
will not edit any of those table paths. No held Pi/Vite work is admitted.

The Sim owner retains `package.json`, `bunfig.toml`,
`scripts/test-suite-boundary.test.ts`, `scripts/coverage-threshold.test.ts`,
`scripts/desktop-sim-payload.test.ts`, all hosted Sim implementation and joined
journeys. Other owners return test commits and any selector proposal; only the
Sim owner integrates shared coverage selection. Thresholds and exclusions stay
unchanged. No production-source changes are assigned below.

## Runtime owner: durable-data test batch

These tests are automatically selected by the existing DB unit-directory input.
Tests must use disposable local data/fakes and retain the existing contract
assertions. No live database, migration, provider or private factory execution is
part of this allocation.

| Deficient measured file                                            | Exclusive test path                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `packages/db/src/agent-persona-policy.ts`                          | `packages/db/tests/unit/agent-persona-policy.test.ts`              |
| `packages/db/src/control-plane-identifiers.ts`                     | `packages/db/tests/unit/control-plane-identifiers.test.ts`         |
| `packages/db/src/event-contract.ts`                                | `packages/db/tests/unit/event-contract.test.ts` (new)              |
| `packages/db/src/lead-turn-rollback-policy.ts`                     | `packages/db/tests/unit/lead-turn-rollback.test.ts`                |
| `packages/db/src/migration-snapshot-capture.ts`                    | `packages/db/tests/unit/migration-snapshot-capture.test.ts`        |
| `packages/db/src/migration-snapshot-legacy.ts`                     | `packages/db/tests/unit/migration-snapshot-legacy.test.ts`         |
| `packages/db/src/task-submission-retention.ts`                     | `packages/db/tests/unit/task-submission-retention.test.ts`         |
| `packages/db/src/transactions.ts`                                  | `packages/db/tests/unit/transactions.test.ts`                      |
| `packages/db/tests/fixtures/cutover-rehearsal.ts`                  | `packages/db/tests/unit/cutover-rehearsal.test.ts`                 |
| `packages/db/tests/fixtures/lead-production-factory-preflight.mjs` | `packages/db/tests/unit/lead-production-factory-preflight.test.ts` |
| `packages/db/tests/fixtures/lead-production-factory-process.mjs`   | `packages/db/tests/unit/lead-production-factory-process.test.ts`   |

The last two paths are fault/provenance unit tests only. Keep fixture
implementations, private package pins, actual factory execution and held Pi
checkouts outside the batch. Read the workspace-events spec before event-contract
work and relevant migration/rollback documentation before their cases.

## Canvas owner: tooling and pure boundary test batch

| Deficient measured file            | Exclusive test path(s)                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `scripts/capture-provisioning.mjs` | `scripts/capture-provisioning.test.ts`; `scripts/capture-provisioning-smoke-faults.test.ts` |
| `scripts/ci-lane-selection.mjs`    | `scripts/ci-lane-selection.test.ts`                                                         |
| `scripts/e2e-preparation.mjs`      | `scripts/e2e-preparation.test.ts`                                                           |
| `scripts/orch-toolchain.mjs`       | `scripts/orch-runtime.test.ts`                                                              |
| `scripts/sign-desktop-update.mjs`  | `scripts/desktop-update-boundary.test.ts`                                                   |
| `scripts/vite-plus-proof.mjs`      | `scripts/vite-plus-proof.test.ts`                                                           |
| `packages/auth/src/adapter.ts`     | `packages/auth/tests/integration/adapter.test.ts`                                           |
| `apps/web/start/client-policy.mjs` | `apps/web/test/client-policy.test.ts` (new, direct pure-policy import)                      |
| `packages/types/src/index.ts`      | `packages/types/tests/workspace-primitives.test.ts` (new, direct public-barrel guards)      |

The two existing auth suites use in-memory drivers/SDK fakes, despite their
integration-directory names. They already pass six tests, but need additional
failure and sign-in/sign-out cases to meet the line goal. No real auth service,
credentials or access changes are part of this allocation. Their explicit
coverage selection, plus the two new pure suites, returns to the Sim owner.

Do not add the whole existing `apps/web/test/start-host.test.ts` to the shared
lane: a direct root-run probe fails its Solid JSX setup (`jsxDEV` export), before
exercising client policy. A targeted pure-policy test avoids importing unrelated
UI. This is an observed probe failure, not a passing shared-lane receipt.

Private CLI functions can make a source seam necessary (for example the private
`verify` in `orch-toolchain.mjs`). If test-only work cannot reach a path, return
an exact minimal source proposal to root rather than editing production source,
measuring an instrumented copy, excluding a file or counting subprocess
execution as in-process source coverage. No new source authority is implied.
Use fixture signing material only; do not access release keys or publish feeds.

## Sim owner: existing config suite selection

`apps/web/test/cloudflare-config.test.ts` already measures
`apps/web/cloudflare.config.ts` at 100% functions/lines across eight passing tests.
It needs selection, not duplicate test edits. The Sim owner is adding this exact
existing suite while retaining every previous input and flag, and extending the
existing exact-inventory assertion. The restored full lane passes 1,401 tests and records 21 remaining deficient
files; root's earlier 22-file list included this selection-only gap.

## Admission and publication rules

Runtime owner: existing task `01a14aad-e9ec-7146-8ba4-b3706759c0c5`.
Canvas owner: existing task `01a14ab7-c695-73ef-85de-c0b79d0c20f5`.
Root admission is explicit: recheck overlap, change only the assigned test paths,
publish checked draft PRs with auto-merge OFF, and return source-seam or selector
proposals instead of editing production/configuration. Sim retains selectors,
enforcement, joined implementation and qualification. No owner may edit the
other table. Any additional path requires root coordination.

Private Agent Sim #111 is frozen at reviewed `341e616`. Root reports it merged
at `9746854a037cea2f99f239e1701a19c3be363577` following the user's direct action.
The subsequent private #114 event belongs to root's read-only reconciliation.
This Sim task will not modify that scope or attempt another merge route. No
release or production deployment is authorized.
