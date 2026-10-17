# Run Workspace Tasks with Vite+ (`vp run`)

- Status: Accepted (landed in #1433, 2026-10-17). Supersedes the "Task orchestration and caching" row of
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
  task cache and save it on push only. Hosted timing has not been measured; the opt-in lane in
  [Vite+ cache proof lane](../vite-plus-proof.md) (#1425) checks that the cache saves and restores, not how fast.

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
  Uncached tasks (the desktop tests, the coverage lane) receive the full environment. The web build
  declares `VITE_*`, the four `ADEA_PUBLIC_*` names that `vite.config.ts` substitutes into the
  browser code (read from `PUBLIC_ENV_NAMES`, so a new name cannot be missed) and
  `ADEA_AGENT_SIM_DIST`. `ADEA_PUBLIC_DEPLOY_GIT_COMMIT_SHA` is embedded in the output, so a build
  that sets it is a miss on every commit.
- The Agent Sim engine pack that `ADEA_AGENT_SIM_DIST` names is a directory outside the workspace,
  and `bun` copies it, so no input glob can name it. A digest of its files is written into the web
  build command (`ORCH_AGENT_SIM_PACK=<digest>`, `none` when unset), computed when the graph loads.
  A relative path is resolved against `apps/web`, as `scripts/pack-agent-sim.mjs` resolves it. The
  staging script follows links for `engine.json` and `engine.js` and copies the rest as links, so the
  digest covers each link's own text and, through the walk, the contents of its target. A link is
  accepted only when its real path is inside the pack (links to directories are not descended, so a
  cycle ends). A link that leaves the pack, a dangling link, an unreadable entry or a special file
  makes the digest unknown, and the web build then runs uncached instead of trusting a partial digest.
- Different environment values and different pack digests are separate cache entries, so returning
  to an earlier value replays it; editing a tracked file replaces the entry for its command.
- Cloudflare deploy lanes skip Code Foundry's Turbo-only affected check and deploy conservatively.
- `lint` results can depend on `packages/ui/dist` when a discovery-sensitive rule reads the barrel.
  Lint declares no dependency on it, as under Turbo.

## Evidence (one host, 4 vCPU, Node 24.21.0 for the final run and 24.18.0 earlier, Bun 1.4.0; not a benchmark)

Output parity is stated per run, not as a blanket claim:

- Same source, same checkout path: Turbo at main `878939b1` against Vite+ at `ef153ac8`, fresh
  clones with a frozen install, Node 24.21.0. All 1,782 files of the 15 `dist` directories were
  compared by SHA-256. 1,772 are identical. The 10 that differ are all under `apps/web/dist/server`:
  eight chunks whose content-derived names changed, and `index.js` and `.vite/manifest.json`, which
  name them. The difference is the Bun store directory suffix in `//#region` comments
  (`better-auth@1.6.23+364b92bc23e0ea47` against `+4c689408c6010410`), which follows from the
  regenerated `bun.lock` that adds `vite-plus`, not from the runner. With that suffix and the chunk
  hashes normalised, every `apps/web/dist/server` file is identical. Each runner is deterministic:
  two Turbo builds agree with each other and two Vite+ builds agree with each other.
- An earlier directory-level manifest showed different `apps/web/dist` hashes for equal sizes. Its
  cause was not isolated at the time and the comparison was not repeated as such; the file-level
  comparison above supersedes it. A checkout path also appears in `server/wrangler.json`, so builds
  from different paths differ in that file and in the chunk name derived from it.
- Merged head `ef153ac8`, fresh clone, frozen install: cold build, typecheck, lint and
  `test:unit` exit 0; second warm pass hits 15/15, 31/31 and 17/17. The first warm lint and web build
  miss once because `bun test --coverage` creates `coverage/`. In one warm `test:unit` the uncached
  desktop suite had two git-provider tests time out at 5 s while other tasks ran; the same suite
  alone passed 1,416 of 1,416 three times.
- Web build cache contract, tested by editing and varying inputs on a warm cache: editing
  `scripts/pack-agent-sim.mjs` misses; each `ADEA_PUBLIC_*` value misses when changed and hits when
  repeated; an engine pack directory misses when first set, when a file's content changes at the same
  path and when a file is added, and hits when unchanged. With `engine.js` a link to a file in the
  pack, the build misses when the target's content changes and when the link is retargeted, and hits
  when neither does; with a link that leaves the pack the web build runs every time.
- Edits invalidate exactly the tasks that depend on them (library source, a package's tests, the web
  app, desktop shell source that the web tests read, `bunfig.toml`, the test preload, the source
  contract setup script); a failing type check, lint, test or dependency build exits non-zero and is
  never replayed; changing a declared `VITE_*` variable misses and an undeclared one hits.
- A cold full build took about 62 s with concurrency 4 against 58 to 76 s under Turbo's default
  concurrency on this host; a fully cached build, typecheck and lint take about 1, 2 and 5 s.
- Hosted CI on this branch has not been observed.
