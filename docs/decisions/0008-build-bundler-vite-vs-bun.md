# Build and Bundler: Vite vs Bun

- Status: Accepted (2026-09-13). **Vite 8 (Rolldown) + Turborepo stay on every
  build surface; Bun's bundler is not adopted anywhere.** Measured in M7; the
  per-surface evidence is below.
- Date: 2026-09-13
- Tracks: #304 (this evaluation) — milestone M7, Build & Bundler Evaluation.
  The measurement harness lived outside the repository and is deleted; this page
  is the durable record.
- Scope: every surface that turns workspace source into shipped artifacts —
  `apps/web`'s TanStack Start production build (Cloudflare Worker + client
  assets), `apps/web`'s desktop SPA build (`vite.desktop.config.ts`, consumed by
  `apps/desktop/scripts/client.mjs`), the library packages' `dist` builds, the
  dev/watch loops, and Turborepo's task caching. The language and meta-framework
  choice is [0007](./0007-solid-tanstack-start.md) and is not re-opened here;
  the desktop shell's runtime and its bundling are
  [0006](./0006-browser-lanes-and-desktop-shell.md).

## Decision

**Bun replaces nothing on the build path.** Bun stays the package manager,
script runner, and test runner — that is not what was measured. Its _bundler_
(`bun build` / `Bun.build`) loses on every surface where it was a candidate,
and two surfaces are forced by the framework before any benchmark runs.

| Surface                                                    | Decision                       | Why                                                                    |
| ---------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `apps/web` Start production build (Worker + client)        | Vite — forced by the framework | TanStack Start's build is a Vite plugin pipeline (evidence below)      |
| `apps/web` desktop SPA/prerender build                     | Vite — forced by the framework | Same Start plugin pipeline in SPA mode; the desktop lane only wraps it |
| Library `dist` (`ui`, `workspace-ui`, `audio`, `data`)     | Vite + `tsc` (incumbent)       | 3–7% faster package builds is not worth the output-shape and DX losses |
| TypeScript-only `dist` (`types`, `auth`, `db`, `state`, …) | `tsc` (incumbent)              | Bun has no per-module emit; `bundle: false` inlines the graph          |
| Dev/HMR — Start dev server and `vite build --watch`        | Vite                           | Forced for the app; the incumbent watch path has no Bun equivalent     |
| Task orchestration and caching                             | Turborepo (incumbent)          | Not a bundler candidate; measured so the end state is recorded         |
| Desktop shell (`apps/desktop/shell`, Electrobun)           | Bun (already)                  | Electrobun's main process is Bun; there is no Vite path to compare     |

No dual build configuration, compatibility wrapper, or benchmark script exists
in the repository as a result of this evaluation. The losing configurations are
recorded here as rejected, with the measurement that rejected them.

## Measurement environment

Same machine, same checkout for every number; `origin/main` at
`5102661` (the M6 Solid/TanStack Start migration).

| Item      | Value                                                                  |
| --------- | ---------------------------------------------------------------------- |
| Machine   | Apple M2 Max, 12 cores, 64 GB, macOS 26.6.2                            |
| Bundlers  | Vite 8.2.2 (Rolldown), `vite-plugin-solid` 2.11.14, Bun 1.4.0          |
| Compilers | TypeScript 6.0.3 (`tsc`), `babel-preset-solid` 1.9.15 (via the plugin) |
| Runner    | Turborepo 2.10.12, Bun 1.4.0 scripts, Node 24.18.0                     |
| Method    | 3 cold runs (output directory removed) + warm runs; medians reported   |

Library timings are wall seconds for the build steps the package scripts run, so
they are directly comparable to `turbo run build`.

## Library packages: Vite + `tsc` vs Bun

The four JSX packages compile Solid JSX into `dist` and emit declarations with
`tsc --emitDeclarationOnly`. A Bun prototype reproduced that contract: every
source file as an entry point, bare specifiers external, `splitting: true`, and
an `onLoad` plugin running `babel-preset-solid` — because Bun does not compile
Solid JSX itself.

### Wall time (median of 3 cold runs, seconds)

| Package                 | Vite JS | Bun JS | `tsc` declarations | Vite total | Bun total | Delta |
| ----------------------- | ------- | ------ | ------------------ | ---------- | --------- | ----- |
| `packages/ui`           | 0.385   | 0.273  | 2.071              | 2.456      | 2.344     | −4.6% |
| `packages/workspace-ui` | 0.557   | 0.461  | 2.237              | 2.794      | 2.698     | −3.4% |
| `packages/data`         | 0.263   | 0.196  | 0.726              | 0.989      | 0.922     | −6.8% |
| `packages/audio`        | 0.266   | 0.183  | 0.879              | 1.145      | 1.062     | −7.2% |

**The declaration emit dominates and Bun cannot do it.** TypeScript declarations
require `tsc` either way, so the bundler swap only competes for 0.1–0.2 s of a
1.0–2.8 s package build. A 3–7% package-build improvement does not pay for a
bespoke build script plus three new direct dev dependencies (`@babel/core`,
`babel-preset-solid`, `@babel/preset-typescript`) — `babel-preset-solid` is not
even resolvable from the library packages today; it arrives nested under
`vite-plugin-solid`.

### Artifacts (JS only, `dist`; declarations identical either way)

| Package                 | Vite             | Bun                     |
| ----------------------- | ---------------- | ----------------------- |
| `packages/ui`           | 30 files, 92 KB  | 52 files, 108 KB (+16%) |
| `packages/workspace-ui` | 47 files, 298 KB | 93 files, 358 KB (+20%) |
| `packages/data`         | 3 files, 39 KB   | 4 files, 44 KB (+11%)   |
| `packages/audio`        | 5 files, 8 KB    | 9 files, 10 KB (+20%)   |

The Bun output is not just larger; it has a different shape. Vite's
`preserveModules` emits the published tree one-to-one (every `dist/x.js` is the
compiled `src/x.ts`), which is what the packages' `exports` maps
(`./components/*`, `./lib/*`) address by path. Bun has no `preserveModules`
equivalent: with `splitting: true` it hoists shared modules into hash-named
chunks at the output root, so `dist/index.js` and the deep-entry shims re-export
from `index-<hash>.js` chunk files. That is functional — one module instance,
working deep imports — but it is a regression from a one-to-one module tree to a
chunk graph, for a package-level win of under 0.2 s.

### Correctness

The prototype's `dist` was swapped in behind the real export conditions
(`bun test --conditions=browser` resolves `@adea-ai/ui` and friends through
`dist`, not `src`) and the affected suites passed: 47 `workspace-ui` tests, 26
`data` tests, 89 `apps/web` tests. The package suites import their own `src` for
most of their coverage, so that is a weak gate — which is itself an argument for
not changing the artifact underneath them for a sub-second win.

## `apps/web`: the framework owns the pipeline

Start's production build and the desktop SPA build are the same Vite plugin
pipeline. The evidence, gathered before any timing:

- `@tanstack/start-plugin-core@1.171.42` declares `vite >= 7.0.0` as a **peer
  dependency** and imports from `vite` **48 times** in its published `dist`. Its
  entry points are Vite virtual modules it supplies from the plugin container:
  `virtual:tanstack-start-client-entry`,
  `virtual:tanstack-start-server-entry`,
  `virtual:tanstack-start-dev-client-entry`,
  `virtual:tanstack-start-plugin-adapters/{client,server}`,
  `virtual:tanstack-start-validate-server-fn-id`, and the `virtual:tanstack-rsc-*`
  family. Bun has no plugin container to serve them.
- `@cloudflare/vite-plugin` declares `vite ^6.1.0 || ^7.0.0 || ^8.0.0` as a peer
  dependency and owns the Worker environment: bindings, `wrangler.json`, static
  asset emission, and `.dev.vars`. The deploy artifact is a Worker bundle, not a
  browser bundle.
- The desktop config is `tanstackStart({ spa: … })` — the same Solid and
  client-boundary plugins in SPA/prerender mode. `apps/desktop/scripts/client.mjs`
  only validates the cloud origin and calls `vite build` with that config; there
  is no separate desktop bundler to replace.
- Bun was given a fair attempt: `bun build --target=browser --splitting` on the
  Start client entry bundled 71 modules in 23 ms — but the 334 KB output contains
  **65 `createComponent(` calls and zero `template(` calls**: Bun lowered the JSX
  with its own runtime transform instead of the Solid compiler, and resolved
  `solid-js/dist/dev.js`. It is not a smaller build of the same program; it is a
  different program.

The honest record: this surface's decision is forced by the framework. Bun
cannot drive a TanStack Start build, and the `--target=bun` alternative has no
Cloudflare Worker output, no integration bindings, and no prerender step.

### Measured baselines (3 runs; medians)

| Command                                                                       | Wall time          |
| ----------------------------------------------------------------------------- | ------------------ |
| `bun run --cwd apps/web build` (full script)                                  | 5.68–6.24 s (5.78) |
| `bunx vite build` (apps/web, both environments)                               | 5.09–5.30 s (5.10) |
| `bun run --cwd apps/desktop shell:client:build` (workspace deps turbo-cached) | 5.34–5.43 s        |

| Artifact                | Size                                |
| ----------------------- | ----------------------------------- |
| `apps/web/dist`         | 2.73 MB, 62 files                   |
| — `dist/client`         | 1.12 MB, 44 files (tar.gz 310.5 KB) |
| — `dist/server`         | 1.58 MB, 17 files                   |
| `apps/web/dist-desktop` | 2.65 MB, 54 files                   |
| — `dist-desktop/client` | 1.13 MB, 44 files (tar.gz 313.4 KB) |

Largest client chunks: `client-*.js` 328.35 KB (gzip 81.13), the workspace shell
147.95 KB (gzip 40.49), `preferences-*.js` 100.98 KB (gzip 30.80). Largest
server chunks: `router-*.js` 659.66 KB (gzip 123.49), `request-scope-*.js`
407.76 KB (gzip 92.88), `index.js` 221.85 KB (gzip 50.52).

## TypeScript-only packages: Bun cannot replace `tsc`

Eight packages (`types`, `api-client`, `app-core`, `asset-manifests`, `auth`,
`db`, `state`, `spatial-protocol`) publish per-module ESM emitted by `tsc`, and
they still need `tsc` for declarations. The candidate was Bun's `bundle: false`
transpile, which is what its name suggests only in the single-file case:

| Package         | `tsc` output                                   | Bun `bundle: false`                                  |
| --------------- | ---------------------------------------------- | ---------------------------------------------------- |
| `packages/db`   | 34 JS files, 243 KB (656 KB with declarations) | 34 JS files, 6,074 KB — 25× the JS bytes, in 0.035 s |
| `packages/auth` | 16 JS files                                    | 16 entries → 16 outputs, in 0.037 s                  |

Each Bun output carries its **entire dependency graph inlined**: `dist/index.js`
keeps none of the 18 relative specifiers (`./artifacts`, `./connection`,
`./config`, …) that the `tsc` emit preserves, and imports `node:crypto` four
times under four aliases because the same module is reached through four inlined
paths. `dist/artifacts.js` is 5,847 lines where `tsc` emits 349. Duplicated
module instances would break the singleton semantics these packages rely on, and
the declarations still require `tsc` regardless. Rejected; `tsc` stays.

## Dev and watch

| Surface                                                    | Measurement                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| Start dev server (`bun run --cwd apps/web dev`)            | Vite ready in 2,047 ms; first HTTP 200 at 3.21 s from spawn |
| `packages/ui` watch rebuild after a source touch           | 0.07 s / 0.11 s / 0.11 s                                    |
| `packages/workspace-ui` watch rebuild after a source touch | 0.24 s / 0.24 s / 0.26 s                                    |

Both are already sub-300 ms and framework-bound (the app) or fast enough that a
swap cannot be noticed. There is also no drop-in Bun equivalent: `Bun.build()`
accepts `plugins` but has **no watch mode**, and the `bun build` CLI has
`--watch` but **no plugin flag** (Bun 1.4.0 `bun build --help`), so a Bun library
watch would need a hand-rolled file watcher around the Babel plugin — strictly
worse than `vite build --watch`.

## Turborepo cache behavior

Not a candidate, measured because #304 asks for cold/incremental/warm and cache
numbers.

| Run                                                             | Result                           |
| --------------------------------------------------------------- | -------------------------------- |
| Cold (empty cache directory, 13 build tasks)                    | 12.04 s, 0 cached                |
| Warm (repeat)                                                   | 21 ms — full turbo, 13/13 cached |
| Incremental (one content change in `packages/ui/src/index.tsx`) | 10.68 s, 10/13 cached            |
| Cache directory for a full build                                | 1.0 MB                           |

A full-content hash change on a leaf package rebuilds `ui`, `workspace-ui`, and
the web app; everything else stays cached. CI lane durations on the same
workflows: Validation 102–188 s, TanStack Start Host 129 s, Desktop shell 47 s.

## Rejected configurations

| Configuration                                                                         | Rejected because                                                                                                                                    |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bun + `babel-preset-solid` `onLoad` plugin, `splitting: true`, all sources as entries | Works, but emits hash-named shared chunks instead of the published module tree, is 11–20% larger, and needs three new direct dev dependencies       |
| Bun `bundle: false` per source file for the TypeScript-only packages                  | Inlines each entry's whole graph (25× the `tsc` JS bytes) and drops shared module identity                                                          |
| `solid-js/h` JSX runtime with `jsxImportSource` switched in `tsconfig`                | A different runtime with no template optimization — a product change, not a bundler swap, and it would trade reactivity performance for build speed |
| `bun build --app` (Bun's experimental web-app build)                                  | No TanStack Start integration, no Cloudflare Worker target, no prerender — it cannot produce the deploy artifact                                    |
| Bun for the Start/Prerender/Worker pipeline                                           | No plugin container for Start's virtual modules; `@cloudflare/vite-plugin` is Vite-only by peer dependency                                          |

## Measured tradeoff: the ineffective dynamic-import boundary

#304 asks for the desktop dynamic-import boundary to be resolved or documented.

At M7 the boundary was **documented, not resolved**. Rolldown reported it in both
the web and desktop builds —

```
[INEFFECTIVE_DYNAMIC_IMPORT] ../../packages/workspace-ui/src/create-workspace-dialogs.tsx
is dynamically imported by conventional-workspace-shell.tsx but also statically
imported by ../../packages/workspace-ui/src/workspace-sidebar.tsx
```

— and the emitted chunk confirmed it. `conventional-workspace-shell-*.js`
(147.99 KB, gzip 40.52) contained both the sidebar's markup and the dialogs'
code, and no `import(` remained in that chunk: the lazy dialogs loaded eagerly
with the shell because `workspace-sidebar.tsx` imported them statically, so the
module could not be hoisted into its own chunk. The dynamic import cost nothing
and saved nothing.

**M8 (issue #305) resolved it with two shared-UI changes; the bundler is
unchanged.** The measurement below is from `bun run --cwd apps/web build` and
`bun run --cwd apps/desktop shell:client:build` on the same machine, before and
after the change in the same checkout:

| Change                                                                                              | Measured effect                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace-sidebar.tsx` `lazy()`-imports `EditRoomDialog` / `RenameConversationDialog`              | Rolldown emits `create-workspace-dialogs-*.js` (9.24 KB, gzip 2.62); the shell chunk shrinks to 139.39 KB (gzip 38.73); the `INEFFECTIVE_DYNAMIC_IMPORT` warning disappears from the web and desktop builds                                         |
| the shell mounts each lazy dialog only while its id is active (it previously rendered them eagerly) | the workspace mount path no longer fetches `create-workspace-dialogs` (9,247 B / 2.62 KB gzip) or `workspace-utility-dialogs` (7,294 B / 3.11 KB gzip); the shell's reachable JS drops from 838.3 KiB to 827.5 KiB raw (242.0 → 238.6 KiB gzip-sum) |

Evidence that the split is real rather than nominal: `create-workspace-dialogs`'
UI strings appear in the M7 shell chunk and no longer appear in it, the shell
chunk now carries `import(` for its remaining lazy dialogs, and the dev server
serves `create-workspace-dialogs.tsx` and `workspace-utility-dialogs.tsx` on the
workspace mount path before the change and not after it. The desktop client
(`dist-desktop`) shows the same shell-chunk reduction, 147.99 KB → 139.39 KB
(gzip 40.52 → 38.74). Total `dist` bytes are approximately unchanged (a split
adds files and re-distributes shared modules); the win is that dialog code is no
longer parsed or fetched before a dialog is opened.

Resolving it meant changing shared UI code (the sidebar's import, the shell's
dialog mount condition, and the drawer component the dialogs share), not
choosing a different bundler — both Rolldown and Rollup make the same call for
the same graph.

## What would change this decision

- **Bun gaining `preserveModules`-style per-module output** and a first-class
  Solid JSX transform (not Babel) would make the library surface worth
  re-measuring; the 3–7% gap would become a real number instead of rounding.
- **TanStack Start shipping a non-Vite build backend** (it already ships an
  Rsbuild plugin; the shared core is still Vite-first) would make the app
  surfaces measurable rather than forced.
- **Declaration emit leaving `tsc`** would change the library arithmetic, since
  it is the dominant cost today.
- None of these are actionable now, and none is scheduled work.

## Consequences

- One build system, one plugin ecosystem, one cache: Vite 8 (Rolldown) for the
  app and the libraries, `tsc` for declarations and type-only packages,
  Turborepo for task caching.
- Bun keeps the roles it is demonstrably good at here: install, scripts, the
  test runner, and the Electrobun desktop shell's own Bun main process.
- The evaluation left no harness, config, or dependency behind; the numbers
  above are reproducible with the commands in the tables.
- `scripts/build-bundler-boundary.test.ts` pins the decision so a dormant Bun
  build path cannot reappear unnoticed.

## Exception (2026-09-18, issue #396): the terminal sidecar ships as a compiled Bun executable

`bun build --compile` is adopted for exactly one artifact: the detached
versioned terminal sidecar entry
(`apps/desktop/shell/src/dev-runtime/terminal/sidecar/entry.ts`). This is a
process artifact, not a build path for workspace sources — the Vite/Rolldown
decision above is unchanged for every app and package build surface.

Why the exception is safe within this decision's terms:

- The sidecar is a detached executable the supervisor spawns, not an output of
  the application build graph. No app/package build configuration, plugin, or
  output shape changes; `scripts/build-bundler-boundary.test.ts` continues to
  pin the build surfaces.
- A single versioned binary gives the adoption handshake exactly what
  [dev-runtime.md](../specs/dev-runtime.md) requires to authenticate: one
  executable identity, one artifact digest for the component manifest, and one
  compatibility window per release — no runtime resolution of an entry script
  against a changing checkout.
- The packaging lane already ships Bun artifacts (the Electrobun shell main
  process is Bun); the compile step adds no new runtime dependency.

Measured spawn-time delta (same machine family as the tables above, Bun 1.4.0,
macOS arm64; time from process start to the owner-only endpoint file on disk):

| Launch                                    | Time to endpoint file                       |
| ----------------------------------------- | ------------------------------------------- |
| `bun run entry.ts` (script)               | 20–33 ms across 3 runs                      |
| compiled binary, first launch after build | 878 ms (one-time macOS binary verification) |
| compiled binary, warm launches            | 21–22 ms across 2 runs                      |

Warm spawn is at parity with script launch (~20 ms); a freshly installed
binary pays a one-time first-launch verification cost on macOS, which the
supervisor's bounded startup window absorbs. The adoption rationale is the
versioned single-file artifact and the cleaner handshake, not spawn speed.
