# Agent HQ Frontend Stack and Vanilla Three.js Boundary

- Status: Accepted
- Date: 2026-08-20

## Decision

Use Turborepo, Next.js, React, and TypeScript for the Agent HQ web
application; vanilla Three.js behind a dedicated scene-runtime abstraction for
spatial rendering; TanStack Query for server state; nuqs for shareable URL
state; Zustand for shared client-only state; and shadcn/ui for the application
UI foundation.

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
Shareable workspace context such as scene, camera mode, and selected agent is
represented in the URL through nuqs. Zustand is limited to client-only concerns
such as character choice, panel visibility, view mode, and other transient
coordination. React Three Fiber is not part of the core rendering stack.

The scene-runtime package owns detailed scene-runtime, asset, animation,
performance, and UI implementation conventions as those systems are added.
