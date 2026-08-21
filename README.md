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
packages/
  asset-manifests/             Authorized scene manifest contracts
  rooms/                       Authorized room assets and contracts
  scene-runtime/               React-independent Three.js controller boundary
  ui/                          Shared shadcn-compatible primitives
scenes/
  hq-home/                     Authorized home scene assets
  hq-work/                     Authorized work scene assets
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

The web app is available on port 3000 by default. The initial `/api/agents`
route is a local fixture boundary for the first UI slice and should be replaced
by the backend contract when that service is introduced. Scene and room assets
are retained at their authorized PR-178 baseline; the floorplan designer and
post-PR-178 HQ runtime are not part of this repository.

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
