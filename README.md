# Agent HQ

Agent HQ is a spatial command workspace for multi-agent AI management.

The initial web foundation follows the accepted frontend stack decision:

- Turborepo for the workspace graph and task orchestration.
- Next.js, React, and TypeScript for the application shell.
- Vanilla Three.js behind `@agent-hq/scene-runtime` for spatial rendering.
- TanStack Query for authoritative remote/server state.
- Zustand for ephemeral client-only coordination.
- A shadcn-compatible `@agent-hq/ui` package for accessible, composable UI primitives.

## Repository shape

```text
apps/
  hq/                          Next.js App Router application
scenes/
  hq-home/                     Home scene manifest and authored assets
  hq-work/                     Work scene manifest and authored assets
packages/
  asset-manifests/             Scene and layout contracts
  ithappy/                     HQ character, animation, and prop assets
  rooms/                       Room gallery and designer contracts/assets
  scene-runtime/               React-independent Three.js controller boundary
  ui/                          Shared shadcn-compatible primitives
docs/decisions/                Accepted architecture decisions
```

React owns the product UI and lifecycle. The scene runtime owns the Three.js
scene graph, camera, render loop, renderer lifecycle, and future asset/animation
systems. The two communicate through the controller API exported by
`@agent-hq/scene-runtime`; React does not reach into the Three.js scene graph.

Durable agent, workspace, task, and message data belongs on the backend and is
queried through TanStack Query. Zustand is intentionally limited to selection,
panel visibility, view mode, and other transient coordination state.

## Local development

```bash
pnpm install
pnpm dev
```

The web app is available on port 3000 by default. The `/api/agents` and
`/api/layout` routes are local contract boundaries for the first UI slice and
should be replaced by backend contracts when that service is introduced.
Nifty League World assets, audio, and World scene runtime code are intentionally
outside this repository.

## Verification commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Package tasks live in their package manifests and are orchestrated from the
root through `turbo run`.
