# Agent HQ

Agent HQ is a browser-based spatial workspace with Home and Work scenes,
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

For a direct, non-Portless launch, use `PORT=3004 bun run dev`.

- Home: [https://agent-hq.localhost/?scene=home](https://agent-hq.localhost/?scene=home)
- Work: [https://agent-hq.localhost/?scene=work](https://agent-hq.localhost/?scene=work)
- Room designer: append `&roomDesigner=1` to the selected scene URL

Cross-app portal defaults use `agent-hq.localhost` and `world.localhost`. Set
`NEXT_PUBLIC_AGENT_HQ_WORLD_URL` when the sibling World app uses a different
Portless name.

The asset sync step copies the HQ scene foundations and the domain asset
packages—interior, landscape, pets, and characters—into the ignored Next
public-assets directory.

## Runtime and asset performance

Scene field catalogs use `InstancedMesh` for repeated foliage and props, and
the runtime enables frustum culling, Meshopt GLB decoding, and KTX2/Basis
decoding through Three.js. The checked-in interior optimization command is
`bun run assets:optimize:interior` and `bun run assets:optimize:runtime`; they
preserve authored transforms/material boundaries while applying Meshopt geometry
compression and WebP base-color textures. Runtime asset validation is included
in `bun run perf:check` and currently covers all character, pet, and landscape
GLBs. Normal maps remain lossless until a Basis/KTX encoder is available; the
runtime loader and transcoder assets are already wired so normal-map candidates
can be migrated to UASTC without changing scene code.

## Verification

```text
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build

# Browser/runtime gate (starts the dev app automatically when PERF_BASE_URL is unset)
PERF_BASE_URL=http://localhost:4304 bun run perf:gate
```

`bun run build` includes the static route/asset budgets and desktop/mobile
native smoke checks. `bun run perf:gate` additionally runs the Chromium scene
probe and writes `.artifacts/scene-performance.json`; the runtime gate rejects
missing load/runtime reports, scene errors, oversized transfers, and slow frames.

The desktop shell currently reports the upstream GTK3/glib advisory from
`cargo audit` because Tauri's Linux webview stack still depends on the
unmaintained GTK3 bindings. The current Tauri release has no compatible GTK4
replacement, so this remains an explicit dependency follow-up rather than a
silenced audit exception.
