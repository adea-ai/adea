# SolidJS on TanStack Start

- Status: Accepted (2026-09-13). Owner directive for milestone M6 (Language &
  Meta-framework Evaluation), issue #303; supersedes the React and shadcn/ui
  selection in [0001](./0001-frontend-stack-and-scene-runtime.md).
- Date: 2026-09-13
- Scope: the entire UI stack — `apps/web` (the TanStack Start host),
  `packages/ui`, `packages/workspace-ui`, `packages/audio`, `packages/data`
  providers, and `packages/state`. The desktop shell
  ([0006](./0006-browser-lanes-and-desktop-shell.md)) is unchanged: it still
  serves the web app's own desktop build, and the single-UI rule still holds.

## Decision

The owner decided, without a benchmark: **migrate the entire UI stack to
SolidJS and keep TanStack Start as the meta-framework.** The end state is one
Solid codebase; no React dependency, compat shim, or dual-framework path
remains.

TanStack Start runs Solid in the installed version line, so no deviation was
needed. `@tanstack/solid-start` 1.168.50 pairs with `@tanstack/solid-router`
1.170.33 — the same generator line as the React packages it replaces. The Start
host, the route tree, the SPA desktop build, and the Cloudflare worker build all
work unchanged in shape.

## What was migrated

| Surface           | Before                                             | After                                                                                    |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Meta-framework    | `@tanstack/react-start` + `@tanstack/react-router` | `@tanstack/solid-start` + `@tanstack/solid-router`                                       |
| UI primitives     | `@base-ui/react` shadcn-style components           | Kobalte (headless) + corvu (drawer)                                                      |
| Icons             | `lucide-react`                                     | `lucide-solid`                                                                           |
| Theming           | `next-themes`                                      | in-package Solid `ThemeProvider` / `ThemeScript` / `useTheme`                            |
| Server state      | `@tanstack/react-query`                            | `@tanstack/solid-query`                                                                  |
| Client state      | `zustand`                                          | `solid-js/store` (`workspaceStore` + `useWorkspaceState`)                                |
| URL state         | `nuqs`                                             | the router's own search params (`search-codec.mjs` stays the parser/stringifier)         |
| Composition       | React `render` props, hooks, `Suspense`/`lazy`     | Solid `as` props, signals/effects, `Show`/`For`, `lazy` + `Suspense`                     |
| Library build     | `tsc` emitting React JSX into `dist`               | Vite + `vite-plugin-solid` (`dist`) plus `tsc --emitDeclarationOnly` for types           |
| Desktop single UI | web app's React SPA build                          | the same web app's Solid SPA build (`apps/web/vite.desktop.config.ts`, unchanged wiring) |

The shared CSS never depended on the component runtime: the token layer
(`theme.css`, `workspace-shell.css`, `auth-shell.css`) and the workspace
stylesheets are unchanged. The Tailwind state variants and utilities the
components rely on were previously imported from the `shadcn` CLI package; they
are now vendored, framework-neutral, as `packages/ui/src/styles/base.css`.

## Primitive library replacements

The owner's directive was that the shadcn-style component layer must be rebuilt
on **Base UI** primitives. The official Base UI package
(`@base-ui-components/react`, 1.0.0-rc) is **React-only**, and this milestone
migrates the app to Solid in the same directive, so Base UI itself cannot be
the primitive layer. The only Solid-side "Base UI" packages are unmaintained
third-party forks (`@photon-ai/base-ui-solid`, `@msviderok/base-ui-solid`);
adopting an unmaintained fork of a 1.0.0-rc library was rejected. **Kobalte** is
the faithful Solid equivalent — the mature, maintained Solid headless-primitive
library in the same lineage — and is now the single primitive layer under the
shadcn-style components in `packages/ui`, fully replacing every React primitive
dependency. Zero Radix or Base UI imports remain anywhere in the repository.

| Component                                             | Primitive source                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Dialog                                                | `@kobalte/core/dialog`                                                             |
| Drawer (swipe)                                        | `@corvu/drawer`                                                                    |
| Dropdown menu                                         | `@kobalte/core/dropdown-menu`                                                      |
| Tooltip                                               | `@kobalte/core/tooltip`                                                            |
| Tabs                                                  | `@kobalte/core/tabs`                                                               |
| Switch                                                | `@kobalte/core/switch`                                                             |
| Radio group                                           | `@kobalte/core/radio-group`                                                        |
| Toggle / ToggleGroup                                  | `@kobalte/core/toggle-button`, `@kobalte/core/toggle-group`                        |
| Separator                                             | `@kobalte/core/separator`                                                          |
| Badge, Card, Field\*, Input, Label, Skeleton, Spinner | plain Solid elements plus `class-variance-authority` and the shadcn class contract |
| Theme provider                                        | `packages/ui/src/components/theme-provider.tsx` (in-package Solid)                 |

Kobalte's state attributes differ from Base UI's (`data-expanded`/`data-closed`
instead of `data-starting-style`/`data-ending-style`), so the transition classes
inside those components were rewritten against the attributes Kobalte emits.
The `data-slot` contract that tests and CSS key on is unchanged.

### Theming deviation

Kobalte ships `ColorModeProvider`, which writes `data-kb-theme` on the document
element. Adea's token layer keys dark mode on the `.dark` class
(`@custom-variant dark (&:is(.dark *))`), so the theme provider stays in-package:
it keeps the previous provider's contract exactly (a `dark` class plus
`color-scheme` on `<html>`, `localStorage` key `theme`, system default,
transitions suppressed for the switching frame) without a bridge to a second
theme attribute. `ThemeScript` in the root document restores the theme before
first paint.

### Library build

`packages/ui`, `packages/workspace-ui`, `packages/audio`, and `packages/data`
compile JSX in their published `dist` with Vite and `vite-plugin-solid`, which
emits `solid-js/web` template calls; declarations come from
`tsc --emitDeclarationOnly`. Each package's exports map carries a `solid`
condition pointing at its source, so a Solid bundler (Vite with
`vite-plugin-solid`) compiles the original JSX instead of consuming the
pre-compiled `dist`. That is the standard Solid library layout and it keeps the
production bundle template-optimized.

`vite-plugin-solid` must run with `ssr: true` in the web app: without it the
plugin emits DOM-transformed code in the SSR environment, and the router's
module-scope template calls fail on the server.

## Known, documented React presence

`@neondatabase/auth` (the hosted Neon Auth SDK) ships a React UI kit
(`@neondatabase/auth-ui`) as a transitive dependency. No workspace code imports
it: `packages/auth/src/client.ts` uses the framework-neutral
`BetterAuthVanillaAdapter` from `@neondatabase/auth/vanilla`, and the server
paths use `@neondatabase/auth/server`. The desktop client build proves the
separation — `apps/web/start/client-policy.mjs` now rejects React, Radix, Base
UI, and the React-only libraries from the browser graph, and
`apps/web/dist-desktop/.checks/client-modules.json` (the build's module
evidence) contains none of them.

## Consequences

- One runtime, one reactivity model, one component library family across web,
  desktop, and the shared packages.
- `packages/ui` and `packages/workspace-ui` no longer depend on a framework
  component runtime at all beyond Solid itself; the shared CSS remains
  framework-neutral.
- The desktop shell pipeline is untouched: it still builds the web app's
  desktop SPA (`bun run shell:client:build`) and serves it from loopback with
  the injected bridge. The `scripts/desktop-*-boundary.test.ts` gates assert
  the single-UI rule against the Solid entry points.
- Tests render Solid through `bun test --conditions=browser`, so component
  modules resolve the browser build of `solid-js/web` exactly like a bundler
  would.
