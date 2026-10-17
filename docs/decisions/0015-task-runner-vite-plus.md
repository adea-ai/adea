# Run Workspace Tasks with Vite+ (`vp run`)

- Status: Accepted for review (2026-10-17). Supersedes the "Task orchestration and caching" row of
  [ADR 0008](0008-build-bundler-vite-vs-bun.md); every other row stands.
- Date: 2026-10-17
- Scope: how `build`, `typecheck`, `lint` and the package `test` scripts are ordered and cached
  across the workspace, in local use and in CI. It does not change what any package script does,
  the bundlers, the test runner, or the coverage lane.

## Decision

`vp run` (Vite Task, from `vite-plus`) replaces Turborepo as the workspace task runner. Bun still
runs every test, install and script.

- The root `vite.config.ts` loads `scripts/orch-graph.mjs`, which builds the task graph from the
  workspace manifests: `orch:<package>:<build|typecheck|lint|test>` plus the aggregates
  `orch:build`, `orch:typecheck`, `orch:lint`, `orch:test` and `orch:deps-of-<package>:build` (the
  set `turbo run build --filter=@adea-ai/web^...` selected). Root scripts call the aggregates.
- The ordering is the Turbo one: build and typecheck wait for the `build` of every workspace
  dependency, lint waits for nothing, and a package's test waits for its own build. Builds restore
  `dist/**`.
- `.github/code-foundry.yml` sets `monorepo_tool: vite-plus`; the generated workflows restore the
  task cache and save it on push only. Hosted timing has not been measured.

## What is explicit, and why

Vite Task fingerprints what `node` reads. It cannot see what Bun loads, so every task lists its
inputs: the package, its workspace dependencies' `dist` (all of the dependency for tests, because
tests import `../../../packages/types/src/...`), the lockfile and TypeScript and lint config, the
Bun test preload that `bunfig.toml` names, and files a test reads outside its package.
`scripts/orch-graph.test.ts` checks the graph against the manifests and fails if a test reads a
file outside its package that the task does not list.

The graph also carries these decisions, each found by running both runners:

| Finding                                                                                                                                                                                  | Handling                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `vp` sets `FORCE_COLOR=1` for cached tasks; `packages/db`'s factory-process test parses a child's stderr and fails on colour codes                                                       | The variable is removed from every cached command                                    |
| Vite Task tracks file reads with an `LD_PRELOAD` shim that it re-injects into descendants; the desktop suite asserts that no loader variable reaches a child with a scrubbed environment | `apps/desktop` tests run uncached (Turbo cached them)                                |
| TanStack Start's `loadEnv(mode, root, '')` makes Vite report every environment variable to the runner, so `OLDPWD` or a CI run id missed the web build                                   | The runner's client address is unset for that one task; `VITE_*` is declared instead |
| `packages/remote-content`'s test script rebuilds `dist`, which made the task "modify its inputs"                                                                                         | Its own `dist` is not an input of its test                                           |
| `packages/ui/tests/shared-ui-boundary.test.ts` and three web and data tests read other packages' sources                                                                                 | Listed as inputs (Turbo's package-level hash missed them)                            |

## Known limits

- Vite Task keeps one cache entry per task: alternating A, B, A re-runs the task.
- A directory appearing in the workspace root changes the fingerprint of tasks that list it.
  The root `coverage/` created by `bun test --coverage` re-runs lint and the web build once.
- The root `oxlint --deny-warnings` and the coverage lane stay uncached, as under Turbo.
- Environment variables reach cached tasks only when declared, as under Turbo's strict mode.
  Uncached tasks (the desktop tests, the coverage lane) receive the full environment.
- Cloudflare deploy lanes skip Code Foundry's Turbo-only affected check and deploy conservatively.
- `lint` results can depend on `packages/ui/dist` when a discovery-sensitive rule reads the barrel.
  Lint declares no dependency on it, as under Turbo.

## Evidence (one host, 4 vCPU, Node 24.18.0, Bun 1.4.0; not a benchmark)

- `dist` of all 15 packages is byte-identical to the Turbo build, cold and after deleting every
  `dist` and replaying from the cache.
- Edits invalidate exactly the tasks that depend on them (library source, a package's tests, the web
  app, desktop shell source that the web tests read, `bunfig.toml`, the test preload, the source
  contract setup script); a failing type check, lint, test or dependency build exits non-zero and is
  never replayed; changing a declared `VITE_*` variable misses and an undeclared one hits.
- A cold full build took about 61-65 s with concurrency 4 against 76 s for the same graph under
  Turbo's default concurrency; a fully cached build, typecheck and lint take about 1.6, 1.7 and 0.7 s.
