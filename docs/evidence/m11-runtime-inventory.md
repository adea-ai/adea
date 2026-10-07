# M11 runtime inventory product increment

Scope: [#37](https://github.com/adea-ai/adea/issues/37), the cloud-backed
Workspace details › Connections inspector. This is independent implementation
and local product evidence, not full issue or milestone acceptance.

## Behavior

The existing authorized registered-node and public SDK discovery routes now have
a typed, cancellable client/query path and a lazy product surface. The inventory
client projects only display, version, registration and proof fields into its
cache; the existing identity response's public keys and arbitrary trust metadata
are excluded from that projection. This does not change the identity route's
wire contract or claim that it omits public keys.

Users inspect one host and one page at a time. Registration and proof-derived
health, Control Plane node health, individual connection health, freshness,
compatibility, capabilities/support, grants, entitlement, eligibility and
limitations remain separate. Discovery transport stays unreported. Inspection
does not change execution location, authorize submission or alter history.

Client/workspace/node/cursor identities fence query results. Closing the pane or
replacing its scope cancels unused reads; inactive pages have zero retention.
Refresh/pending/error states hide prior inventory. Successful empty discovery
differs from unavailable discovery. A local clock ages observations without
network polling. Committed node events invalidate the registered-host/discovery
group inside the existing workspace cache boundary.

## Local validation — 2026-10-07

- New client/query/presentation tests were run before implementation and failed
  on the missing methods/modules, then passed after implementation. The eight
  focused tests pass with 49 assertions. The broader client/data/model/docs run
  passed 89 tests with 335 assertions.
- `mise exec -- bun run test`: 30 successful Turbo tasks; the root coverage gate
  passed 301 tests and 7,123 assertions. No coverage threshold changed.
- `mise exec -- bun run typecheck`: 31 successful tasks.
- `mise exec -- bun run lint`: 17 successful tasks plus the root published-plugin
  check, with no suppressions or consumer exemptions added.
- `mise exec -- bun run build`: 15 successful tasks. Shared UI source extraction
  verifies 99 rendered shared modules against 182 Tailwind sources.
- `mise exec -- bun run --cwd apps/web start:check-bundle`: passes unchanged
  budgets (no caps changed in this increment): 157 JavaScript files, 2,975,474 raw bytes and 906,584 gzip bytes.
  Chat's additional route graph is 304,083 raw / 101,040 gzip bytes. The host pane
  reuses the existing lazy Control Plane settings entry.
- `mise exec -- bunx --no-install code-foundry doctor`: passed.
- Headless Playwright runs of `apps/web/e2e/runtime-inventory.spec.ts` and
  `apps/web/e2e/workspace-settings.spec.ts` passed 40 cases. The inventory tests
  exercise the production components, query hooks and API client with synthetic
  route replies. They cover lazy entry, keyboard activation, host/page switching,
  grant/health separation, empty/unavailable/forbidden replies, identity mismatch,
  revocation on discovery, failed refresh, close/late response, workspace/client
  replacement, capability support omission, future-dated proof disagreement and
  aging without extra requests.
  At 320/768/1024/1440 pixels in light and dark themes, reduced motion, heading fit,
  overflow and automated WCAG 2 A/AA and 2.1 AA checks pass. Screenshots were
  inspected; these are fixture product views, not packaged/deployed acceptance.
  The final combined run used an explicit 8,192 MiB Node heap for the test Vite
  process after a default 4 GiB Vite process exhausted its heap during the
  existing settings cases. No product or CI heap setting changed.
- Both product specs are included in `scripts/e2e-playwright.mjs`. The runner
  regression executes the actual script with captured process dispatches and
  verifies both unsharded and sharded entry; 11 boundary tests / 181 assertions
  passed. It failed before the new specs were wired in.

The first browser run failed keyboard activation after switching sections; an
unchanged focus assertion reproduced it. Independent loading boundaries for the
three Connections panes fixed the focus loss while sibling lazy modules settled.
Screenshot review also found crowded phone headings; flattening the inspector
sections and moving actions below titles fixed them, with a heading-fit gate.
One later browser attempt never reached Vite readiness and ran no tests; its
recorded process group and allocated port were verified closed before retry.
The first bundle gate found 158 files against the 157-file cap. Reusing the
existing settings entry fixed it without changing budgets. A later cold browser
attempt failed to import the harness after Chromium reported suspended network
requests; it reached no keyboard assertion. The final unchanged keyboard case
passed. A regression also exposed that taking the earlier of two proof dates
could hide a future date; combined inspection now treats either future date as
unknown, proved for both orders and through the actual pane.

No database migration, production configuration, deployment, live host connection
or node mutation is part of this increment. Native direct-local discovery and
the full packaged/deployed certification matrix remain separate requirements.
No source checkbox or acceptance-ledger verification state is changed.

## Host integration boundary still to align

Control Plane owns durable host acceptance and the normal CommandInbox. At its
verified `main` revision
[`5314fa17906d17cf83cbe76cdcd80fa2d5d296a3`](https://github.com/adea-ai/control-plane/tree/5314fa17906d17cf83cbe76cdcd80fa2d5d296a3),
[`@control-plane/remote-control-relay` 1.3.0](https://github.com/adea-ai/control-plane/blob/5314fa17906d17cf83cbe76cdcd80fa2d5d296a3/packages/remote-control-relay/package.json)
is private. Its
[v1 protocol](https://github.com/adea-ai/control-plane/blob/5314fa17906d17cf83cbe76cdcd80fa2d5d296a3/packages/remote-control-relay/src/protocol.ts)
uses a flat envelope/header, different identifiers/payload types and different
canonical associated data from Adea's current nested
[RemoteContentEnvelope](../specs/remote-content.md). The HPKE algorithms match;
the authenticated wire profiles do not. Relabelling encrypted fields cannot
translate their authenticated bytes.

Before claiming actual host interoperability, establish a supported versioned
adapter boundary and cross-repository command/result vectors, preserving queued
envelope/key lifecycle and the existing acceptance authority. Do not introduce
an Adea execution inbox as a substitute. SDK acceptance/reconciliation, event
projection, product controls and the pinned live Local/Self-hosted release gates
remain open work; this read-only surface does not discharge them.
