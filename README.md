# Adea

Adea is a browser-based workspace with Home and Work workspaces, chat,
tasks, and a plugin marketplace. The spatial 3D scenes (home/work worlds,
character and interior content, room designer) live in the private Agent Sim
engine repo and mount here through an entitlement-gated remote; this
repository ships the shell, the scene-manifest protocol, and an unavailable
state wherever the virtual view mounts.

## Stack

- Turborepo, TanStack Start, React, and TypeScript
- Bun for installation, scripts, and tests
- Scene manifests and telemetry schema via `@adea-ai/spatial-protocol`
  (the Three.js runtime, scenes, and asset pipeline live in Agent Sim)
- TanStack Query for server state and Zustand for client-only coordination
- shadcn/ui primitives backed by Base UI

## Local development

```text
bun install
portless
```

Portless runs the web app at [https://adea.localhost](https://adea.localhost)
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

- Home workspace: [https://adea.localhost/?scene=home](https://adea.localhost/?scene=home)
- Work workspace: [https://adea.localhost/?scene=work](https://adea.localhost/?scene=work)
- Room designer: append `&roomDesigner=1` to the selected scene URL (renders
  the engine-unavailable state in builds without Agent Sim)

Cross-app portal defaults use `adea.localhost` and `world.localhost`. Set
`NEXT_PUBLIC_ADEA_WORLD_URL` when the sibling World app uses a different
Portless name.

The asset sync step stages the tracked scene manifests from
`@adea-ai/spatial-protocol` into the ignored Next public-assets directory. The
spatial engine itself lives in the private Agent Sim repo and is delivered
through the entitlement-gated engine remote.

## Plugin marketplace

Adea consumes the authoritative registry through the same-origin server
proxy. The proxy calls Control Plane; browser and desktop clients never fetch
GitHub release assets or upstream plugin content directly. The registry's stable
latest artifact is
[`catalog-latest.v1.json`](https://github.com/adea-ai/plugins/releases/latest/download/catalog-latest.v1.json),
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

Adea is a read-only catalog consumer. Add/Enable submits the exact plugin
and release pins, requested harness, and workspace/user identity to Control
Plane. It does not claim local installation state, download upstream content,
or execute plugin content. Control Plane owns authorization, connector and
credential resolution, server-side release verification, installation state,
and execution records. See [`docs/marketplace-consumer.md`](docs/marketplace-consumer.md)
for the integration contract and required environment variables.

## Architecture references

- [`docs/architecture/diagram-sources.md`](docs/architecture/diagram-sources.md) contains the version-controlled Mermaid definitions for Adea-owned product, architecture, data, trust, runtime, Artifact, and event diagrams.
- [`.github/labels.yml`](.github/labels.yml) defines the shared issue-label taxonomy without installing a synchronization workflow.
- Canonical product requirements, TDDs, specifications, ADRs, roadmap decisions, and terminology remain in the Adea Google Docs corpus.

## Runtime and asset performance

The spatial engine (InstancedMesh scene fields, frustum culling, Meshopt GLB
and KTX2/Basis decoding, asset optimization, performance budgets) lives in
the private Agent Sim repo. This repository stages only the tracked scene
manifests from `@adea-ai/spatial-protocol` into the ignored Next
public-assets directory, so plain checkouts build and test with zero setup
and no credentials.

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

# Force Chromium headless (useful for CI or local non-interactive runs)
PLAYWRIGHT_HEADLESS=1 bun run test:e2e
```

Code Foundry runs `test:unit`, `test:integration`, `test:e2e`, and `test:smoke`
as independent jobs so the categories can execute in parallel. Package unit
tests also fan out through Turborepo.

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

`bun run build` covers the workspace packages and the TanStack Start
production build. Native desktop,
Capacitor, Android `assembleDebug`, and unsigned iOS device-SDK compiler checks
live in the separate `bun run test:smoke` category. The headless E2E command above is suitable for CI and functional/layout
coverage of the shell and chat flows; scene performance gates live with the
engine in Agent Sim.
Native compiler checks skip platforms whose toolchains are unavailable on the
current host; set `NATIVE_SMOKE_STRICT=1` in a platform-specific CI job to make
an unavailable or missing platform fail the gate.

The desktop shell currently reports the upstream GTK3/glib advisory from
`cargo audit` because Tauri's Linux webview stack still depends on the
unmaintained GTK3 bindings. The current Tauri release has no compatible GTK4
replacement, so this remains an explicit dependency follow-up rather than a
silenced audit exception.
