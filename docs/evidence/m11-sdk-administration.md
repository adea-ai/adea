# M11 SDK administration increment

Recorded 2026-10-07 on `feat/m11-agent-execution`, based on `0c57d1f7d`.
Public package pins: `@adea-ai/sdk` 1.11.0 and `@adea-ai/contracts` 1.14.0.
Runtime: Node 24.21.0 through `mise exec`, Bun 1.4.0. Both packages are
Apache-2.0; the added runtime dependencies are contracts and Zod. No Control
Plane implementation checkout, service, or production credentials were needed.

The production catalog and credential proxy now calls the public SDK. Its
fixtures exercise strict schemas, incompatible versions, request/trace identity,
workspace ownership, sanitized authentication and transport errors, secret
canaries, and the real five-second abort signal. Browser denylist fixtures and
the compiled bundle guard keep runtime SDK/schema modules server-side.

| Command                                                                                                   | Result                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                                                           | Passed with exact package pins and lockfile integrity.                                                                                                                                                                                          |
| `npx --no-install code-foundry doctor`                                                                    | Passed.                                                                                                                                                                                                                                         |
| `mise exec -- bun test apps/web/test/control-plane-sdk.test.ts apps/web/test/control-plane-admin.test.ts` | 22 passed, 0 failed; 159 assertions.                                                                                                                                                                                                            |
| `bun run --cwd apps/web test`                                                                             | 282 passed, 0 failed before the additional real-deadline regression. That regression subsequently passed in the focused command above.                                                                                                          |
| `mise exec -- bun run test`                                                                               | All workspace unit tasks and root coverage passed; root coverage suite: 296 passed, 0 failed.                                                                                                                                                   |
| `bun run typecheck`                                                                                       | All 30 workspace tasks passed.                                                                                                                                                                                                                  |
| `mise exec -- bun run --cwd apps/web typecheck`                                                           | Fresh web type generation and TypeScript check passed.                                                                                                                                                                                          |
| `mise exec -- bun run lint`                                                                               | All 17 tasks passed; zero warnings/errors in the affected web package.                                                                                                                                                                          |
| `mise exec -- bun run format:check`                                                                       | Passed; the subsequently added deadline test separately passed Oxfmt.                                                                                                                                                                           |
| `bun run build`                                                                                           | Serial workspace build passed all 15 tasks after an initial concurrent test/build asset-staging collision.                                                                                                                                      |
| `mise exec -- bun run --cwd apps/web build`                                                               | Fresh production build passed; 98 rendered shared UI modules verified against 180 Tailwind sources.                                                                                                                                             |
| `mise exec -- bun audit`                                                                                  | No vulnerabilities found across 840 packages.                                                                                                                                                                                                   |
| `mise exec -- bun run test:integration`                                                                   | 84 passed, 0 failed against a newly allocated loopback Postgres target; its Compose project and volume were removed.                                                                                                                            |
| `mise exec -- bun run --cwd apps/web start:test:local`                                                    | Equivalent invocation of `start/test-local.mjs` under a resource-recording wrapper passed 44 headless desktop/mobile Worker browser tests, restricted entry and guest API checks. Owned Worker processes and isolated Postgres were cleaned up. |

The Worker suite establishes local host and browser-boundary compatibility.
Catalog/credential success and failure responses come from deterministic public
SDK fixtures; the Worker was not connected to a live Control Plane. Execution
submission, direct Local IPC, remote relay, persistence-profile conformance,
packaged desktop journeys and deployed certification remain unverified.

This evidence supports part of [M11 #36](https://github.com/adea-ai/adea/issues/36).
It does not close that issue's residual acceptance requirements or M11. The
[acceptance ledger](../plans/m11-acceptance.json) preserves every source criterion.
