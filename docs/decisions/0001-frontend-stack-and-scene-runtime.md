# Agent HQ Frontend Stack and Vanilla Three.js Boundary

- Status: Accepted, superseded in part
- Date: 2026-08-20
- Superseding note (2026-09-11): the web host is now TanStack Start on
  Cloudflare Workers with Vite, replacing the original Next.js/OpenNext host.
  Everything else in this decision still holds: vanilla Three.js behind the
  scene-runtime abstraction, TanStack Query for server state, Zustand for
  client-only state, and shadcn/ui for UI primitives.

## Decision

Use Turborepo, React, and TypeScript for the Adea web application, served by
TanStack Start; vanilla Three.js behind a dedicated scene-runtime abstraction
for spatial rendering; TanStack Query for server state; Zustand for shared
client-only state; and shadcn/ui for the application UI foundation.

## Alternatives considered

- React Three Fiber for the spatial layer.
- Redux Toolkit or custom global state management.
- Server Components/server actions as the primary interactive data-state layer.
- Fully custom UI primitives.

## Rationale

Agent HQ is an interaction-heavy web application with both conventional
product UI and a performance-sensitive spatial workspace. React should own
application UI and lifecycle, while the Three.js runtime retains direct control
of the scene graph, render loop, camera, animation, interaction, asset
lifecycle, and performance systems. TanStack Query cleanly owns remote/server
state without duplicating it into client stores. Zustand provides a small shared
state layer for ephemeral UI and scene coordination. shadcn/ui provides
accessible, composable UI primitives without constraining the product's visual
design.

## Consequences

React and Three.js communicate through a narrow scene-controller/state boundary.
Durable workspace, task, message, and Agent data remains authoritative on the
backend and is cached through TanStack Query rather than mirrored into Zustand.
Zustand is limited to client-only concerns such as selection, panels, view mode,
camera/interaction state, and other transient coordination. React Three Fiber
is not part of the core rendering stack.

The scene-runtime package owns detailed scene-runtime, asset, animation,
performance, and UI implementation conventions as those systems are added.
