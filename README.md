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

## Verification

```text
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```
