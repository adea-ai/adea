# Hosted Agent Sim integration

Agent Sim is an optional online-first surface. The app's HQ, room designer,
and character designer entries use `HostedSimEntry` and the existing hosted
component. Chat and Dev stay in the bundled UI; they do not subscribe to Sim
launch state. A failed Sim launch does not revoke their workspace identity.

## Boundaries

- `GET /api/sim/config` returns the configured exact frame origin. The server-only
  `ADEA_SIM_ORIGIN` has no hostname default. Local HTTP requires an explicitly
  injected loopback allowance in the acceptance fixture; the production route
  does not enable it.
- `POST /api/sim/launch` carries the existing API client's authentication and
  cancellation signal. `createSimApi` admits only exact trusted host origins,
  bounds JSON to 4096 bytes, and delegates to an authoritative issuer. Without
  that issuer it returns `unavailable/not_configured`, even with a hostname.
- `createSimHost` runs at a distinct origin and cookie host. Its public frame
  document and bootstrap contain no private engine bytes. CSP admits only the
  configured exact parents and self-hosted scripts, with the WebAssembly-only
  directive needed by the existing decoder. No generic JavaScript eval is enabled.
- The frame captures its parent origin, nonce, and home/work scene from a fragment,
  then clears it. No launch code or session goes in a URL. The frame accepts only
  the configured parent window/origin/nonce and the closed existing bridge schema.
- `host.launch` is exchanged once at `/session`. The merged exchange service sets
  the existing Secure, HttpOnly, SameSite=None, Partitioned `__Host-adea-sim` cookie.
  The frame imports private engine code only after that exchange succeeds.
- Every `/assets/agent-sim/*` request checks the Sim session and expiry before
  reading storage. Engine entry access is bound to the session's surface. Responses
  use `private, no-store`; there is no public asset alias or direct storage URL.
  Storage adapters must confine reads to the private export and reject escaping links.
- Disposal aborts exchange, removes listeners, and unmounts a late engine result.
  Existing private exports register the same mount API; no engine source or binary
  is copied into this repository.

## Local acceptance

Use the repository's pinned Bun and frozen dependencies, build workspace
prerequisites with `bun run build:web-deps`, then run:

```sh
bun test apps/web/test/sim-http.test.ts apps/web/test/sim-frame.test.ts
bun test apps/web/test/sim-offload-browser/acceptance.test.ts
bun scripts/check-hosted-sim-desktop-client.ts
ADEA_SIM_TEST_EXPORT=/path/to/existing/private/export \
  bun scripts/check-hosted-sim-desktop-save.ts
ADEA_SIM_TEST_EXPORT=/path/to/existing/private/export \
  bun test apps/web/test/sim-offload-browser/acceptance.test.ts
```

The browser lane requires the existing Playwright Chromium installation. It is
separate from the ordinary unit lane. It starts disposable loopback services,
uses an explicit test entitlement and in-memory reference stores, and mounts the
actual app entry, host component, frame bootstrap, and exchange/asset boundaries.
The optional private export stays on the local machine. Local screenshots stay
under the temporary evidence directory and are not uploaded or committed.

The HTTP lane covers denial before private storage reads, single-use code replay,
session expiry, surface binding, missing authority, foreign origins, and bounded
requests. Frame lifecycle tests cover foreign messages, duplicate launch, failed
exchange, and disposal during a pending mount. The browser lane checks the actual
partitioned cookie, separate cookie hosts, no Sim cookie on Adea API requests,
an expired-session refusal followed by a fresh launch, and a fresh Sim launch after reconnect. Its small Chat/Dev panels qualify frame isolation only. The separate `check-hosted-sim-desktop-client.ts` command serves the actual built desktop UI with disposable API/bridge fixtures and verifies that its real Chat/Dev screens remain reachable while Sim is unavailable or offline. Neither fixture proves native authorization or offline cloud execution.

## Desktop payload proof

`pack-agent-sim.mjs` is now a migration refusal: legacy `ADEA_AGENT_SIM_DIST`
configuration fails instead of staging a pack. Asset sync emits only the tracked
scene manifests. The desktop loopback server refuses the former engine mount.
The client build checks its output with `check-desktop-sim-payload.mjs --client`;
the release workflow checks the inner installed archive with `--archive` before
publication. Existing published installers are not changed by this source patch.

## Parent navigation and persistence

The reviewed bridge dependency adds closed `frame.navigate` requests for the two
designers and an acknowledged `frame.character.save` request. The frame uses
`createCharacterSaveClient`; an engine save succeeds only after its exact host
response. The app checks cancellation, workspace, surface, and the active bridge
nonce before synchronously committing the character to the parent URL. That
nonce identifies the launch attempt. The write preserves history state, unrelated
query values, and the hash, then notifies the router. No asynchronous write can
land after a cancelled attempt. HQ and reopened designers read the route's
current character instead of the initial mount snapshot.

The private engine hooks are tracked in AgentSim PR #111. Each HQ transition ends
its current attempt and requests a fresh designer grant. Character editing remains
reactive; edits made during an acknowledgement remain dirty and open. Standalone
designer URL persistence remains supported by the private engine.

The actual-built-client save command uses a private local export and disposable
API/bridge/entitlement/storage fixtures. Its final zero-error assertion deliberately
keeps rendering failures visible. Embedded GLB textures use blob fetches. The
user-approved isolated Sim document policy is `connect-src 'self' blob:`; the
regression fixes every other directive and leaves the app API policy and private
asset session gates unchanged. This grants no live deployment authority.

## Remaining production decisions

The production route deliberately has no entitlement authority installed. Existing
Adea code admitted the legacy engine by official origin/packed manifest; it has
no account entitlement source to reuse. Choosing an account policy or treating
all authenticated workspace members as entitled would create an access grant,
so this patch does neither. An approved service must compose `createSimLaunchIssuer`
with the existing authenticated principal/workspace checks, an authoritative
`SimEntitlementChecker`, and durable, atomically single-use code storage. The
separate host must compose `createSimSessionExchange`, durable session lookup,
and authorized private storage with no alternate public route.

Deployment, hostname/DNS, bindings, credentials, access changes, and any live
rollout require separate explicit authorization. The local reference stores and
entitlement fixture are not production substitutes. No live completion is claimed.

The earlier [hosted Sim bridge follow-up](../plans/hosted-sim-bridge-follow-up.md)
records the coordination proposal; reviewed PR #1450 supplies the bridge contract.
The [parent-save evidence](../evidence/hosted-sim-parent-save-local-2026-10-17.md)
records the actual-client designer round trips and fresh installed payload proof.
The [production composition proposal](../plans/hosted-sim-production-composition.md)
specifies the remaining entitlement, storage, runtime policy, and live authority decisions.
