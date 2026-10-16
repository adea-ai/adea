# Vite+ cache proof lane

An opt-in, non-required lane that exercises the Vite+ task cache on a bounded
slice of the workspace. Turbo remains the required runner: `bun run build`,
`test`, `lint` and `typecheck` and every required workflow are unchanged, and
the committed `.github/code-foundry.yml` does not set `monorepo_tool`.

## What it covers

`vite.config.ts` defines `build` (`tsc`) and `test` (`bun test`) tasks for
`types`, `state`, `api-client`, `app-core`, `auth` and `spatial`, plus a
`proof` task that runs all of them. It is not a Turbo replacement and makes no
speed or parity claim.

Always use the wrapper. It computes the toolchain id from the node and bun
that `vp` will really run and overrides any `ADEA_VP_TOOLCHAIN` in the
environment; setting that variable by hand (`ADEA_VP_TOOLCHAIN=local vp run
proof`) bypasses the runtime identity and is not a valid proof.

```sh
node scripts/vite-plus-proof.mjs                 # run the graph, print hits and a dist manifest
node scripts/vite-plus-proof.mjs --expect warm --fresh   # assert the hit pattern on a clean tree
node scripts/vite-plus-proof.mjs --self-check    # disposable-worktree cold/replay/invalidation checks
```

`--self-check` runs in a throwaway `git worktree` of `HEAD` (with its own
install and cache directory), so it never edits the checkout it is run from.
Success, failure or a killed process can leave at most a temporary directory.
`scripts/vite-plus-proof.test.ts` pins that against a dirty checkout (an
uncommitted edit to the file the self-check mutates, plus an untracked file):
the failure path always runs; the full success path runs with
`ADEA_VP_PROOF=1` and in the proof workflow. It does not use or modify a
`VITE_CACHE_PATH` you have set. It deletes every package's `dist` and requires
the cache to restore byte-identical outputs, because a hit count alone does not
show that artifacts are replayed.

## Why the inputs are explicit

Vite Task does not see files that Bun loads itself, so a Bun-run task cached
with automatic tracking only keeps hitting after its test files change. Every
task here lists its inputs (sources, tests, dependency `dist`, lockfile,
config). `control:types-test-auto-only` is the same test with automatic
tracking only; `--self-check` reports whether it still returns a stale hit.

Vite Task also does not hash the node or bun binary. Each task fingerprints
`ADEA_VP_TOOLCHAIN`, which the script builds from the `node` and `bun` that
`vp` will actually execute (it resolves them from the `packageManager` pin and
its own toolchain, not necessarily the first `bun` on `PATH`), the Vite+
version, platform and architecture.

## CI

`.github/workflows/vite-plus-proof.yml` runs on pushes to its own branch and
by dispatch. It checks out Code Foundry `v1.48.0` (asserting the version and
commit), opts only its own workspace into `monorepo_tool: vite-plus`, and runs
the Code Foundry setup action with its own Vite+ cache step turned off:
1.48.0's step restores but its post-job save fails with "Input required and
not supplied: path". This job restores the task cache after Install and saves
it on push through the same Code Foundry cache wrapper with a static path
(`node_modules/.vite/task-cache`, plus the absolute `VITE_CACHE_PATH` when set),
under a rolling per-run key that never leaves the toolchain id. The override is
read from the step process (so an inherited runner variable counts, not only
workflow `env`) by `--cache-path` and exported as `ADEA_VP_CACHE_PATH`, which
the cache `path` references; the post-job save re-reads that input, where step
outputs are empty.

The proof graph then runs on a fresh runner, where no `dist` exists, so a warm
run replays outputs from the restored cache. Commit-message lines assert the
result: `vp-proof-expect: cold|warm|one-miss`, `vp-proof-miss: <task>` for the
lone miss (for the Bun-only edit, exactly `types:test`), and
`vp-proof-manifest: <sha256>` for the sha256 of all dist outputs. The graph
must have exactly 12 tasks (a build and a test per package), whatever the
expected pattern. No secrets, remote cache or Cloudflare.
