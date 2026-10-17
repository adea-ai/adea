# @adea-ai/spatial

Scene and asset manifest contracts plus the shell-to-engine spatial protocol
for Adea workspaces. It provides types, mount manifests, URL helpers, and
telemetry validation without a rendering engine, binaries, or secrets.

Consolidates the former `@adea-ai/asset-manifests` and `@adea-ai/spatial-protocol`
packages, which always released together; both are deprecated in favor of this
package.

- `asset-manifests.ts`: typed scene data shapes: `SceneManifest`, `SceneZone`,
  `SceneStartPosition`, assigned-props manifests, static-field asset URLs.
- `manifests.ts`: `hqHomeManifest` / `hqWorkManifest` mount constants (mirrors
  the engine's room layout; the engine is source of truth).
- `engine.ts`: agent-sim engine manifest discovery and validation
  (`parseAgentSimEngineManifest`, official web hosts).
- `scene-spawn.ts`: cross-app spawn encode/parse and portal URL helpers.
- `telemetry.ts`: `ScenePerformanceReport` schema, validation, envelope, and
  navigation instrumentation.
- `sim-bridge/` (subpath `@adea-ai/spatial/sim-bridge`): the contract for embedding
  a separately hosted Agent Sim page. See below.
- `data/`: tracked scene manifests (`home/`, `work/`), mirrored from the
  engine's `scenes/sim/assets/`; staged into the web public dir by
  `scripts/sync-assets.mjs`.

The engine manifest validator requires a nonempty version and a same-origin
JavaScript entry URL. Its version is diagnostic; it does not enforce API or
version-range compatibility or verify entry bytes. Tracked scene data is a
public mirror, not proof that every file matches a particular private source
revision or distributed pack. Manifest and payload acceptance need separate
checks against the intended pack.

## Hosted Agent Sim bridge (`@adea-ai/spatial/sim-bridge`)

Schema, validators and a launch contract for a hosted Agent Sim page embedded in an
iframe. It is a subpath export so the default desktop payload and the app bundle do not
include it, and it contains no private Agent Sim or asset code. It has no transport of its
own: callers pass `MessageEvent`-shaped values in and post through `postToFrame` /
`postToHost`.

- **Messages** (`messages.ts`): a closed, versioned set. Frame to host: `frame.ready`,
  `frame.state`, `frame.close`, `frame.error`. Host to frame: `host.launch`,
  `host.dispose`. There is no generic call, eval, filesystem, native-RPC or credential
  message, and the strict payload shapes reject any extra key (a `token` field included).
  Each message is accepted only when its sender origin is on the exact allowlist, its
  `event.source` is the exact frame (or parent) window, its envelope carries the
  per-mount `bridgeId` the host issued (`createBridgeId`), the version is supported, and
  it stays inside a finite size, depth, width and node budget (about 2 KiB; cyclic, deep and
  wide payloads are refused without being walked). Accessor properties are never read, and
  every discriminant is read as an own data property. Posts never use `*`.
- **Origins** (`origin.ts`): exact canonical `scheme://host[:port]` strings. No
  wildcards, suffix matching, paths or `null`. Loopback `http:` needs an explicit
  `allowLoopbackHttp` opt-in for local development. Being on the allowlist says where a
  frame was served from. It is not proof of an official desktop identity or an
  entitlement, and neither is localhost or any value embedded in the app.
- **Launch** (`launch.ts`): the host asks the Adea backend for a launch
  (`SimLaunchRequest`); the backend checks entitlement and returns a one-time code valid
  for at most 120 seconds (`SimLaunchGrant`, which is also refused when it is stale, for
  another surface, or for a frame origin outside the allowlist). The host posts the code
  to the frame, which exchanges it at the sim origin for a sim-only session
  (`SimSessionExchangeRequest` / `SimSessionExchangeResult`). Neither body carries a
  token. `createLaunchOnce` and `createLaunchCodeLedger` pin the single-use behaviour for
  the frame and for a backend implementation to match.
- **Launch service** (`service.ts`): the backend logic for both steps, written against
  injectable ports and with no I/O, endpoint or storage of its own. `createSimLaunchIssuer`
  checks a caller-supplied `SimEntitlementChecker` and issues a code through a
  `SimLaunchCodeStore`; `createSimSessionExchange` redeems it once and returns the
  `Set-Cookie` value separately from the JSON body. The sim origin and the entitlement source
  are inputs, never defaults: an absent or invalid origin answers `not_configured` before the
  entitlement source is asked, and any verdict other than `entitled` fails closed. Nothing
  here chooses where entitlement comes from, where the sim is hosted, or how stores persist.
- **Session cookie** (`cookie.ts`): named `__Host-adea-sim`, with `HttpOnly`, `Secure`,
  `Path=/`, `SameSite=None`, `Partitioned`, no `Domain`, and a lifetime of at most one
  hour. It authorizes the sim origin's assets only, never an Adea account API.
- **Availability** (`availability.ts`): `reduceSimLaunch` is a pure state machine
  (`idle`, `requesting`, `awaiting_frame`, `launching`, `running`, `unavailable`,
  `offline`), and every state carries an `attempt`: `start` begins attempt N+1 and a
  grant, frame message or timeout is applied only when it names the current attempt, so
  a late event from an interrupted attempt cannot launch, fail or close a newer one
  (mint a fresh `bridgeId` per attempt too). A surface is `running` only after the
  frame says so, and
  `describeSimAvailability` gives truthful copy that states Chat and Dev are not affected.

Not part of this package: the hosted entry, the backend endpoints, the private backing
origin that authorizes assets before serving cached responses, and any credentials or
deployment. Those are separate work.
