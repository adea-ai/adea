# M11 RuntimeNode reference increment

Recorded 2026-10-07, based on the SDK increment `3ee0d2249`.
The expand-only migration gives every registered node a stable public `rnr_`
reference for the Control Plane discovery join. It grants no authority and does
not establish a Control Plane registration. Resume, rotation and revocation
retain the reference; separate devices keep separate references.

| Command                                                                                        | Result                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mise exec -- bun run --cwd packages/db db:generate -- --name=control-plane-runtime-node-refs` | Generated migration 0034 and its snapshot; reviewed SQL expands the generator before the column default.                                                                                                                                                                                                                        |
| `mise exec -- bun run --cwd packages/db db:check`                                              | Passed.                                                                                                                                                                                                                                                                                                                         |
| `mise exec -- bun run --cwd packages/db test`                                                  | 29 passed, 0 failed; 3,420 assertions.                                                                                                                                                                                                                                                                                          |
| `mise exec -- bun run test:integration`                                                        | 85 passed, 0 failed; 35 migrations applied and rerun deterministically on an isolated Postgres. Tests exercise stable references, grammar, uniqueness and a 500-row backfill. A first test-helper assertion failed because Drizzle queries are thenables; the corrected async helper passed. Owned database and volume removed. |
| `mise exec -- bun run typecheck`                                                               | All 30 tasks passed.                                                                                                                                                                                                                                                                                                            |
| `mise exec -- bun run lint`                                                                    | All 17 tasks passed.                                                                                                                                                                                                                                                                                                            |
| `mise exec -- bun run format:check`                                                            | Passed after formatting Drizzle's generated JSON.                                                                                                                                                                                                                                                                               |
| `mise exec -- bun run --cwd apps/web build`                                                    | Fresh production build and shared UI source check passed.                                                                                                                                                                                                                                                                       |

`mise exec -- bun run --cwd apps/web start:test:local`, invoked through the
resource-recording wrapper, also passed all 44 existing headless desktop/mobile
production Worker journeys, including real signed pairing, rotation, revocation
and tenant isolation. The compiled client bundle guard passed. Owned Worker and
database resources were cleaned up.

No production migration or deployment was performed. Apply schema expansion
before deploying code that reads the new column. This is identity substrate for
[M11 #37](https://github.com/adea-ai/adea/issues/37); SDK discovery consumption,
client projection, transport diagnostics, and final live certification remain.
