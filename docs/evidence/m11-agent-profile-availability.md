# M11 Agent profile read-time availability

The authorized Agent list and detail routes now project the exact saved pin
through the public SDK catalog and resolver before returning it. The response
includes a check-attempt timestamp and explicit unavailable, missing, deprecated,
revoked, unapproved or incompatible states. Database pins, revisions and audit
records stay unchanged. The roster supplies fixed remediation text and retains
the exact IDs in Customize, without displaying upstream errors or private
profile definitions.

One response checks at most 32 distinct pins with four workers and one five-second
deadline. Shared pins are checked once. Cancellation also bounds pending scope
resolution; late responses cannot change the returned state or initiate a later
network hop. Unchecked pins remain unavailable, and the single-Agent route can
check a pin beyond the list bound.

| Validation                                                                                                       | Result                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mise exec -- bun test apps/web/test/agent-profile-availability.test.ts apps/web/test/agent-profile-pin.test.ts` | 15 passed, 95 assertions. Exact pins, all refusal classes, resolver denial, shared-pin deduplication, four-worker/32-pin bounds, cancellation, and a stalled-scope five-second deadline. No Control Plane repository or process.                                                               |
| `mise exec -- bun run --cwd packages/workspace-ui test`                                                          | 154 passed, 521 assertions, including lifecycle and fixed remediation presentation.                                                                                                                                                                                                            |
| `mise exec -- bun run test`                                                                                      | Complete current-main workspace suite passed: 30 tasks; root coverage suite 296 passed, 7,024 assertions. This run includes the final lifecycle/copy refinement and the merged encrypted-result package.                                                                                       |
| `mise exec -- bun run lint`, `typecheck`, `format:check`, `build`                                                | Passed: 17 lint tasks, 30 type-check tasks, 15 build tasks. The final UI refinement also passed affected lint and type checks.                                                                                                                                                                 |
| Fresh production web build and `start:check-bundle`                                                              | Passed; 99 rendered shared UI modules against 182 Tailwind sources. Chat route 304,078 raw bytes / 100,961 gzip bytes, within the unchanged budgets. Server SDK code remains outside browser output.                                                                                           |
| Compiled production Worker, isolated PostgreSQL                                                                  | 36 migrations and 44 browser cases passed. Additional actual Agent list/detail requests proved unavailable state without a service signer, foreign-tenant refusal, private/no-store responses, and an unchanged saved pin/revision. The test-owned database and Worker were stopped afterward. |
| Focused headless Chromium against the compiled Worker                                                            | Two cases passed: existing pin editing and all remediation states. Light/dark screenshots at 320, 768, 1,024 and 1,440px, keyboard Customize entry, exact IDs and no horizontal overflow. No committed golden changed.                                                                         |
| `mise exec -- bun test scripts/docs-boundary.test.ts`                                                            | Four passed, 15 assertions.                                                                                                                                                                                                                                                                    |
| `mise exec -- npx --no-install code-foundry doctor`                                                              | Passed with the existing mise toolchain.                                                                                                                                                                                                                                                       |

The final UI tooltip wording was shortened after the browser run and checked
by the affected unit/type/lint suite and a fresh production build. Final-head
CI and live candidate certification remain separate from these local checks.

## Remaining acceptance

This is a read and product-remediation increment for #41. It is not execution
authorization. Submission-time transactional snapshots, immutable ExecutionPlan
and Skill provenance, large-inventory pagination and live candidate certification
remain required. No profile automatically follows a newer version. No database
migration, production deployment, credential or external configuration change
is part of this increment.
