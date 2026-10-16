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

```sh
ADEA_VP_TOOLCHAIN=local node_modules/.bin/vp run proof   # or:
node scripts/vite-plus-proof.mjs                          # computes the toolchain id
node scripts/vite-plus-proof.mjs --self-check             # isolated cold/warm/invalidation checks
```

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
commit), opts only its own workspace into `monorepo_tool: vite-plus`, runs the
Code Foundry setup action (task cache restored after Install, rolling
per-run key saved on push), then the isolated self-check and the proof graph.
A `vp-proof-expect: cold|warm|one-miss` line in the commit message asserts the
restored cache's hit pattern. No secrets, remote cache or Cloudflare.
