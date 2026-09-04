# Agent HQ

Agent HQ is a browser-based spatial workspace with Home and Work workspaces,
each backed by its own spatial scene,
character and interior asset packages, a vanilla Three.js scene runtime, and an
orthographic room designer.

## Stack

- Turborepo, Next.js, React, and TypeScript
- Bun for installation, scripts, and tests
- Vanilla Three.js behind `@agent-hq/scene-runtime`
- TanStack Query for server state and Zustand for client-only coordination
- shadcn/ui primitives backed by Base UI

## Local development

```text
bun install
portless
```

Portless runs the web app at [https://agent-hq.localhost](https://agent-hq.localhost)
with a stable named route instead of a fixed development port. Portless requires
Node.js 24 or newer; Bun remains the repository's package manager and test runner.

Workspace bootstrap and temporary guest sessions are persistence-backed. Start the
local PostgreSQL service and load the example server environment before launching
the app:

```sh
cp apps/web/.env.example apps/web/.env.local
docker compose up -d --wait postgres
set -a
. apps/web/.env.local
set +a
bun run --cwd packages/db db:migrate
```

`apps/web/.env.local` is ignored and must never be committed. The `DATABASE_URL`
value is server-only; do not rename it to a `NEXT_PUBLIC_` or `VITE_` variable.

For a direct, non-Portless launch, use `PORT=3004 bun run dev`.

- Home workspace: [https://agent-hq.localhost/?scene=home](https://agent-hq.localhost/?scene=home)
- Work workspace: [https://agent-hq.localhost/?scene=work](https://agent-hq.localhost/?scene=work)
- Room designer: append `&roomDesigner=1` to the selected scene URL; it opens a dedicated scene with its own camera state

Cross-app portal defaults use `agent-hq.localhost` and `world.localhost`. Set
`NEXT_PUBLIC_AGENT_HQ_WORLD_URL` when the sibling World app uses a different
Portless name.

The asset sync step copies the HQ scene foundations and the domain asset
packages—interior, landscape, pets, characters, and reserved room scenes—into
the ignored Next public-assets directory.

## Plugin marketplace

Agent HQ consumes the authoritative registry through the same-origin server
proxy. The proxy calls Control Plane; browser and desktop clients never fetch
GitHub release assets or upstream plugin content directly. The registry's stable
latest artifact is
[`catalog-latest.v1.json`](https://github.com/0xPlayerOne/plugins/releases/latest/download/catalog-latest.v1.json),
and each verified catalog is pinned by its `catalogId` and immutable release
tag.

The shared marketplace provider verifies the catalog schema, canonical catalog
digest, `integrity.json`, and byte-identical latest pointer before mapping the
entries into the workspace UI. It preserves each source-qualified `pluginId`,
exact `releaseId`, `canonicalContentDigest`, provenance,
`harnessCompatibility`, `securityClassification`, and connector/credential
requirements. `metadata-only` entries are visible as unavailable metadata and
cannot be enabled. A stale last-known-good catalog is labeled stale; a failed
verification is fail-closed.

Agent HQ is a read-only catalog consumer. Add/Enable submits the exact plugin
and release pins, requested harness, and workspace/user identity to Control
Plane. It does not claim local installation state, download upstream content,
or execute plugin content. Control Plane owns authorization, connector and
credential resolution, server-side release verification, installation state,
and execution records. See [`docs/marketplace-consumer.md`](docs/marketplace-consumer.md)
for the integration contract and required environment variables.

## Architecture references

- [`docs/architecture/diagram-sources.md`](docs/architecture/diagram-sources.md) contains the version-controlled Mermaid definitions for Agent HQ-owned product, architecture, data, trust, runtime, Artifact, and event diagrams.
- [`.github/labels.yml`](.github/labels.yml) defines the shared issue-label taxonomy without installing a synchronization workflow.
- Canonical product requirements, TDDs, specifications, ADRs, roadmap decisions, and terminology remain in the Agent HQ Google Docs corpus.

## Runtime and asset performance

Scene field catalogs use `InstancedMesh` for repeated foliage and props, and
the runtime enables frustum culling, Meshopt GLB decoding, and KTX2/Basis
decoding through Three.js. The checked-in interior optimization command is
`bun run assets:optimize:interior` and `bun run assets:optimize:runtime`; they
preserve authored transforms/material boundaries while applying Meshopt geometry
compression and WebP base-color textures. Runtime asset validation is included
in `bun run perf:check` and covers the loaded character runtime, pets, and
landscape GLBs. Complete character exports under `packages/characters/assets/_complete`
are available as menu examples but remain outside the configurable wearable
catalog. The optimizer leaves future normal-map candidates
lossless when the KTX encoder is unavailable. The runtime loader and
transcoder assets are already wired for `KHR_texture_basisu` without changing
scene code.

Meshopt remains the geometry default for loaded runtime models. Authoring
inputs remain external; checked-in runtime GLBs are the optimized delivery
artifacts.

## Verification

```text
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run test:integration
bun run test:smoke
bun run build

# Browser/runtime gate (starts the dev app automatically when PERF_BASE_URL is unset)
PERF_BASE_URL=http://localhost:4304 bun run perf:gate

# Force Chromium headless (useful for CI or local non-interactive runs)
PLAYWRIGHT_HEADLESS=1 bun run test:e2e
```

Code Foundry runs `test:unit`, `test:integration`, `test:e2e`, and `test:smoke`
as independent jobs so the categories can execute in parallel. Package unit
tests also fan out through Turborepo. Browser performance tests intentionally
remain serial because concurrent WebGL probes would make the performance gate
nondeterministic.

`bun run test:unit` includes an 80% line-and-function coverage gate for the
durable authentication, persistence, and repository-boundary code exercised by
`packages/auth/tests/unit`, `packages/db/tests/unit`, and `scripts/*.test.ts`.
It writes an ignored LCOV report to `coverage/lcov.info`. The integration entry
point runs the provider-neutral and PostgreSQL cases together. When no database
variables are exported, it starts the repository's local PostgreSQL Compose
service, verifies the restricted migration/runtime roles, applies migrations
deterministically, and runs the complete integration suite. CI and explicit
Neon runs must provide all three canonical variables (`DATABASE_URL`,
`DATABASE_URL_UNPOOLED`, and `DATABASE_MIGRATION_URL`) for an isolated test
branch; production or owner credentials are not valid test targets.

`bun run build` includes the static route and asset budgets. Native desktop,
Capacitor, Android `assembleDebug`, and unsigned iOS device-SDK compiler checks
live in the separate `bun run test:smoke` category. `bun run perf:gate`
additionally runs the Chromium scene probe and writes
`.artifacts/scene-performance.json`; the runtime gate rejects missing
load/runtime reports, scene errors, oversized transfers, and slow frames.
The headless E2E command above is suitable for CI and functional/layout
coverage; run the performance budget gate with a hardware-backed browser on
macOS because SwiftShader headless timings are not representative of the
10-second scene-load target.
Native compiler checks skip platforms whose toolchains are unavailable on the
current host; set `NATIVE_SMOKE_STRICT=1` in a platform-specific CI job to make
an unavailable or missing platform fail the gate.

The desktop shell currently reports the upstream GTK3/glib advisory from
`cargo audit` because Tauri's Linux webview stack still depends on the
unmaintained GTK3 bindings. The current Tauri release has no compatible GTK4
replacement, so this remains an explicit dependency follow-up rather than a
silenced audit exception.
