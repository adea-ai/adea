# Start preview validation

Production-build checks and a controlled local comparison for Adea's web host.

**Date:** 2026-09-10
**Base:** `a22e1722827cf923645b7bfba07983b8dd99db27`
**Toolchain:** Node 24.18.0; Bun 1.4.0; Chromium 153.0.8010.12 on macOS.
**Scope:** Opt-in Start frontend, retained Next auth/API host; no production cutover.

## Performance experiment

Five fresh browser contexts per host, alternating order, using production builds served by local Wrangler over HTTPS. Both received the same bootstrap fixture. The actual legacy entry gate still ran. These are unthrottled desktop measurements, not production Core Web Vitals, authenticated-provider timings, mobile performance, or an engine benchmark.

| Metric (median)                                        | Retained Next | Start candidate |
| ------------------------------------------------------ | ------------: | --------------: |
| Browser-observed workspace DOM readiness               |      325.4 ms |        203.9 ms |
| Chat → virtual-unavailable → chat, automation-observed |      842.8 ms |        158.3 ms |
| Loaded JavaScript encoded body bytes                   |       309,752 |         260,443 |
| Resource transfer bytes, excluding the document        |       347,494 |         297,667 |
| Resource requests                                      |            41 |              39 |
| Bootstrap requests                                     |             1 |               1 |

The JavaScript reduction is approximately 15.9%. Readiness means a visible account control and non-loading conventional workspace shell, recorded by a MutationObserver inside the browser. It does not mean every remote data query has completed. View-switch latency includes Playwright overhead and is not INP. Resource collection includes a fixed 1.5-second observation window after readiness, before switching views. Lazy chunks not requested in that window are not counted as initial payload.

Readiness samples in milliseconds: Next `[331.7, 325.4, 325.0, 325.2, 334.4]`; Start `[233.3, 221.2, 183.2, 193.6, 203.9]`.

## Validation performed

| Command / check                                     | Local result                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                     | Passed; regenerated root lockfile included                                                    |
| `bun run format:check`                              | Passed                                                                                        |
| `bun run lint`                                      | Passed; existing unrelated warnings remain                                                    |
| `bun run typecheck`                                 | Passed                                                                                        |
| `bun run test:unit`                                 | Passed, including the existing coverage command                                               |
| `bun run build`                                     | Passed, including retained Next production build                                              |
| `bun run build:cloudflare`                          | Passed; OpenNext Worker generated locally                                                     |
| `bun run --cwd apps/web start:verify`               | Passed: 34 policies, production build, type check and client guard                            |
| `bun run test:integration` with isolated PostgreSQL | Passed: 38 tests                                                                              |
| `bun run --cwd apps/web start:test:local`           | Passed: 16 desktop/mobile browser checks, restricted entry/API and disconnected-backend gates |
| `bun audit`                                         | Passed: no vulnerabilities reported across 1,055 packages                                     |
| `code-foundry@1.28.4 doctor`                        | Passed                                                                                        |

The browser suite includes live guest-cookie reuse, idempotent writes and tenant isolation through the actual service binding, not only mocked bootstrap UI. It also covers sign-in navigation, settings overlays, view switching, browser back/forward, unknown query retention, genuine 404s, no Next client runtime on the Start page, and recoverable import failure. The existing browser success-page test is not a live OAuth exchange.

## Interpretation and limits

Earlier experiments exposed nested deferred-render delays; the preview loader was adjusted and parity rerun. Earlier cold-readiness values used Playwright polling, so they are not directly comparable to the final browser-side marker above. The local Next control also needed OpenNext's documented `keep_names: false` workaround to eliminate a serialized theme-script error. That adjustment exists only in the isolated test backend, not the production Wrangler configuration.

Both hosts were built from the same migration worktree based on the base commit above. The Next home route has the equivalent extracted entry policy; this is a retained-host comparison, not a fresh production-CDN or immutable-main benchmark. Raw reports and request timing details are retained locally under ignored `.checks/comparison-v2/`; reruns use `.checks/comparison/` by default. No generated bundles or reports are committed.

Hosted OAuth, allowed/denied provider-account flows, production Cloudflare routing, WebSocket delivery/reconnect, native OS compilers and the private Agent Sim engine are not validated by this experiment. The preview deliberately does not switch production commands or DNS. These remain promotion gates, not implicit approvals from a faster local run.
