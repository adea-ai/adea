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
offline Chat/Dev use, and a fresh Sim launch after reconnect.

## Desktop payload proof

`pack-agent-sim.mjs` is now a migration refusal: legacy `ADEA_AGENT_SIM_DIST`
configuration fails instead of staging a pack. Asset sync emits only the tracked
scene manifests. The desktop loopback server refuses the former engine mount.
The client build checks its output with `check-desktop-sim-payload.mjs --client`;
the release workflow checks the inner installed archive with `--archive` before
publication. Existing published installers are not changed by this source patch.

## Remaining production and navigation decisions

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

The current closed bridge has `frame.close` but no request to open another
surface. Direct host designer routes work through their own launch. The private
HQ engine's room/character navigation controls still need a narrowly specified
navigation message and host callback from the separate bridge owner; overloading
`frame.close` would change its meaning and is intentionally avoided.
