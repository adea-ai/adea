# Vite+ cache proof lane

An opt-in, non-required lane that proves the Vite+ task cache saves and restores on real GitHub Actions for the real
`orch:build` graph. Turbo remains the required runner: the committed `.github/code-foundry.yml` does not set
`monorepo_tool`, and no required workflow changes. This is not a Turbo replacement and makes no speed or parity claim.

## What it covers

`vite.config.ts` and `scripts/orch-graph.mjs` define the `orch:*` graph that `bun run build` already runs. The lane
runs `vp run --cache orch:build` and checks what the task cache did:

```sh
node scripts/vite-plus-proof.mjs                          # run the graph, print hits, misses and a dist manifest
node scripts/vite-plus-proof.mjs --expect warm --fresh    # assert the hit pattern on a tree with no dist
node scripts/vite-plus-proof.mjs --expect-manifest <sha>  # assert the sha256 over every workspace's dist
```

`--expect cold` requires no hit; `--expect warm` requires every cacheable task to hit. A hit count alone does not show
that artifacts are replayed, so the warm run starts on a fresh runner (no `dist` exists) and the sha256 over all
workspaces' `dist` output must equal the cold run's.

Every task already fingerprints `ORCH_TOOLCHAIN` (`scripts/orch-toolchain.mjs`), computed from the node and bun that `vp`
runs, so the proof adds no toolchain identity of its own. `vp` runs the Bun named by `packageManager`, which can differ
from the first `bun` on `PATH`; the id in the run summary is the one the tasks used.

## CI

`.github/workflows/vite-plus-proof.yml` runs on pushes to its own branch and by dispatch. It checks out Code Foundry
v1.48.1 at release commit
[`e96e7bdf8c8d5c5074a848813d1ce71954ecdb0d`](https://github.com/0xPlayerOne/code-foundry/releases/tag/v1.48.1),
verifies the commit and package version, stages the pinned runtime under `$RUNNER_TEMP/code-foundry`, and uses that
release's setup action with `cache-vite-plus: true`. It sets `VITE_CACHE_PATH` to a directory under `RUNNER_TEMP` before
setup, then calls the supported `vite-plus-cache-save` action after the build with the setup action's published path,
key and save-intent outputs. The product action owns the cache namespace, key, restore prefixes and push-only save
behavior; Adea has no bespoke cache-key computation. The workflow only opts its own job into `monorepo_tool: vite-plus`.
No secrets, remote cache or Cloudflare are used; the cache is the repository's GitHub Actions cache.

The cache path ends in `adea-vite-plus-proof-cache-orch-v1.48.1`. GitHub derives the archive version from the cache path
list ([cache version reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#cache-key-matching)),
so this proof cannot restore the earlier bounded-slice proof's archives and the first run can assert a cold cache.

Commit-message lines assert the result: `vp-proof-expect: cold|warm` and `vp-proof-manifest: <sha256>` (the dist
outputs after restore).
