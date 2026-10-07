# M11 public runtime discovery increment

Recorded 2026-10-07 after the stable node-reference increment `72c45cc5f`
(rebased onto merged SDK foundation `d452f30ed`).
`GET /api/v1/workspaces/:workspaceId/runtime-nodes/:runtimeNodeId/connections`
joins the authorized Adea registration to public SDK discovery by its exact
`rnr_` reference. The browser consumes an explicit metadata DTO through the
existing API client; no new runtime, credential or history authority is added.

| Command                                                                                                                                                                                                      | Result                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mise exec -- bun test apps/web/test/control-plane-discovery.test.ts apps/web/test/control-plane-sdk.test.ts apps/web/test/control-plane-admin.test.ts packages/api-client/tests/unit/control-plane.test.ts` | 31 passed, 0 failed; 204 assertions. Public SDK fixtures cover binding, independent health, stale/expired/future timestamps, grant and entitlement states, cloud gating and private-metadata canaries.                                                                                            |
| `mise exec -- bun run --cwd apps/web test`                                                                                                                                                                   | 290 passed, 0 failed; 1,233 assertions.                                                                                                                                                                                                                                                           |
| `mise exec -- bun run --cwd packages/api-client test`                                                                                                                                                        | 24 passed, 0 failed; 91 assertions.                                                                                                                                                                                                                                                               |
| `mise exec -- bun run --cwd apps/web build`                                                                                                                                                                  | Fresh final production build and 98-module shared UI source check passed.                                                                                                                                                                                                                         |
| `mise exec -- bun run --cwd apps/web typecheck`                                                                                                                                                              | Passed after route generation. An earlier workspace check correctly failed on the new route before its generated type was rebuilt.                                                                                                                                                                |
| `mise exec -- bun run lint`                                                                                                                                                                                  | All 17 tasks passed, zero web warnings/errors.                                                                                                                                                                                                                                                    |
| `mise exec -- bun run format:check`                                                                                                                                                                          | Passed.                                                                                                                                                                                                                                                                                           |
| `mise exec -- bun run --cwd apps/web start:check-bundle`                                                                                                                                                     | Compiled browser module and size guards passed.                                                                                                                                                                                                                                                   |
| `mise exec -- bun run --cwd apps/web start:check-routes`                                                                                                                                                     | Route boot and hashed-asset caching guards passed on an isolated Worker.                                                                                                                                                                                                                          |
| `mise exec -- bun run --cwd apps/web start:test:local`                                                                                                                                                       | Resource-recording wrapper invocation passed all 44 headless desktop/mobile production Worker cases, including the new route's unavailable-signer state, private caching, node projection, foreign tenant, unknown node, query and desktop-origin refusals. Owned Worker and database cleaned up. |

The compiled Worker fixture deliberately has no service signer or live Control
Plane. Success-path discovery uses the actual pinned SDK and deterministic
responses through the production proxy. No Control Plane checkout/service was
needed to run those tests.

Discovery contract 1.14.0 does not report selected/available RuntimeTransport.
The projection retains `transport.state: 'unreported'`; execution resolution's
transport must be projected separately when available. This is an explicit
remaining #37 requirement, alongside product UI wiring, direct Local transport,
content/history availability and live release-candidate certification. Neither a
successful inventory read nor its eligibility fields authorizes an execution.

After rebasing onto the merged SDK foundation and current shared UI changes,
`mise exec -- bun run test` passed all workspace tasks and root coverage
(296 tests, 7,010 assertions). A fresh web production build verified 99
rendered shared UI modules against 182 sources. Workspace type checks (30
tasks), lint (17 tasks), formatting and compiled browser guards passed. Final
route review added the shared request scope so all database clients close after
the response; the final rebuilt Worker passed all 44 headless desktop/mobile
cases plus restricted entry/API checks. The isolated Worker and database were
removed; process and socket checks found no matching test resource remaining.
