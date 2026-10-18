# Hosted Sim composed coverage evidence

Measured composition: public base `5e9a7943acfcf2fefd35060d81fe5120ca72306d`,
including main `345036ef0622b37def95b10cc55ee4e563c72786`.
App-wrapper/journey/guide changes were unstaged; those are outside the measured
coverage lane and no measured source, coverage config or test was changed.
`bun run test:coverage` ran 1,316 tests / 14,958 assertions / 115 files,
zero test failures, **exit 1**. Aggregate: 85.23% functions / 86.71% lines.
Bun 1.4.3 enforces the unchanged **80% per-file** goals in `bunfig.toml`
(`functions` and `lines`); aggregate success is insufficient.

The real-runner regression in `scripts/coverage-threshold.test.ts` requires
a 50%-function/100%-line fixture to exit 1 and a 100%/100% fixture to exit 0.
No threshold reduction or new exclusion was added. The command completed at the stated composition and remains failing.

| File                                                               | Functions % | Lines % |
| ------------------------------------------------------------------ | ----------: | ------: |
| `apps/web/cloudflare.config.ts`                                    |        0.00 |   19.64 |
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
| `packages/types/src/artifact-reference.ts`                         |        0.00 |   42.62 |
| `packages/types/src/desktop-permissions.ts`                        |        0.00 |   92.31 |
| `packages/types/src/group-participation.ts`                        |        0.00 |   97.56 |
| `packages/types/src/index.ts`                                      |       60.00 |   87.93 |
| `packages/types/src/management.ts`                                 |        0.00 |   24.53 |
| `scripts/capture-provisioning.mjs`                                 |       30.00 |   20.77 |
| `scripts/ci-lane-selection.mjs`                                    |       66.67 |   60.00 |
| `scripts/database-health.mjs`                                      |       80.00 |   63.16 |
| `scripts/docker-pull-backoff.mjs`                                  |       71.43 |   98.17 |
| `scripts/e2e-preparation.mjs`                                      |       80.00 |   51.43 |
| `scripts/orch-toolchain.mjs`                                       |       60.00 |   64.75 |
| `scripts/pack-agent-sim.mjs`                                       |       50.00 |   77.78 |
| `scripts/preview-availability.mjs`                                 |       66.67 |   47.37 |
| `scripts/set-desktop-release-version.mjs`                          |      100.00 |   66.67 |
| `scripts/sign-desktop-update.mjs`                                  |       80.00 |   70.00 |
| `scripts/vite-plus-proof.mjs`                                      |       54.55 |   43.40 |

## Candidate independent test ownership

The following existing test files are unchanged by this Sim owner and can be
considered for a root-coordinated, single-owner assignment:
`scripts/database-health.test.ts`, `scripts/docker-pull-backoff.test.ts`,
`scripts/preview-availability.test.ts`, and
`scripts/set-desktop-release-version.test.ts`. No assignment or ownership
transfer has occurred. Root must resolve any other active ownership first.
The Sim owner retains `bunfig.toml`, `scripts/coverage-threshold.test.ts`,
`scripts/desktop-sim-payload.test.ts` and joined-client implementation.
