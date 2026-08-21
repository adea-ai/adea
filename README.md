# Agent HQ

Agent HQ is a browser-based spatial workspace with Home and Work scenes,
models characters and room props, a vanilla Three.js scene runtime, and an
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
bun run dev
```

The app runs at [http://localhost:3004](http://localhost:3004).

- Home: `/?scene=home`
- Work: `/?scene=work`
- Room designer: append `&roomDesigner=1` to the selected scene URL

The asset sync step copies the scene foundations and the models package,
including the small shared foliage catalog used by Home and Work, into the
ignored Next public-assets directory.

## Verification

```text
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```
