# Vite+ cache proof lane

An opt-in, non-required lane that proves the Vite+ task cache saves and restores on real GitHub Actions for the real
`orch:build` graph. The committed `.github/code-foundry.yml` already sets `monorepo_tool: vite-plus` and
`runtime_ref: v1.48.1`, so the required lanes run this same graph; this lane changes none of them and only adds the
evidence for the cache. It makes no speed or parity claim.

## What it covers

`vite.config.ts` and `scripts/orch-graph.mjs` define the `orch:*` graph that `bun run build` already runs. The lane
runs `vp run --cache orch:build` and checks what the task cache did:

```sh
node scripts/vite-plus-proof.mjs                          # run the graph, print hits, misses and a dist manifest
node scripts/vite-plus-proof.mjs --expect cold --fresh    # the first run: nothing may hit; prints the dist manifest
node scripts/vite-plus-proof.mjs --expect warm --fresh --expect-manifest <cold sha>   # the replay on a fresh tree
```

`--expect cold` requires no hit and needs no earlier manifest. `--expect warm` requires every cacheable task to hit and
refuses to run without `--expect-manifest <sha256>`, the cold run's manifest, so the restored outputs are always compared
with what the cold run built. A hit count alone does not show
that artifacts are replayed, so the warm run starts on a fresh runner (no `dist` exists) and the sha256 over all
workspaces' `dist` output must equal the cold run's.

The root `node_modules` directory listing is not a task input (`VOLATILE_INPUTS` in `scripts/orch-graph.mjs`). Vite creates
and removes `node_modules/.vite-temp` while builds run; a first hosted warm run missed `apps/web build` because the
cold run had recorded that entry ("'.vite-temp' removed from 'node_modules'"). Only the listing is excluded. `node_modules/.vite-temp` and the temporary config file Vite's loader writes into it are excluded by exact path too: the saved web-build entry of a hosted cold run recorded both, and a fresh runner has neither. The web build also leaves out the listings of `apps/web` and `apps/web/public`, the directories it
generates `.wrangler`, `dist`, `cloudflare-env.d.ts` and `public/assets` into (a second hosted warm run missed with "'assets'
removed from 'apps/web/public'"); the files in them stay inputs. Source
files, `VITE_*` variables, `bun.lock` and the toolchain id still invalidate; a source edit and a `VITE_*` change both
still miss.

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
behavior; Adea has no bespoke cache-key computation. The job uses the committed `monorepo_tool: vite-plus`; it appends
nothing to `.github/code-foundry.yml`. No secrets, remote cache or Cloudflare are used; the cache is the repository's GitHub Actions cache.

The cache path ends in `adea-vite-plus-proof-cache-orch-r5-v1.48.1`. GitHub derives the archive version from the cache path
list ([cache version reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#cache-key-matching)),
so this proof cannot restore the earlier bounded-slice proof's archives and the first run can assert a cold cache. The `r5` segment
retires the archives written before the generated-directory listings were excluded from the task inputs (see below); a changed
graph needs a new cold run, then a warm run that names its manifest.

Commit-message lines assert the result: `vp-proof-expect: cold|warm` and `vp-proof-manifest: <sha256>` (the dist
outputs after restore).

## Receipts

Graph `orch-v1.48.1` (before any listing was excluded): cold run 39018357793 saved (0/15, 1792 files, sha256
`2e29f5eb56cd06a505a701192b7163381573276444e100031ae2e2e2aabfa65d`). Its warm runs 39018543532 and 39018606345 failed 14/15
with the same manifest, the miss being `apps/web build` ("'.vite-temp' removed from 'node_modules'").

Graph `orch-r2-v1.48.1` (`node_modules` listing excluded): cold run 39019670060 saved (0/15, same sha256). Its warm run
39019923271 failed 14/15 with the same manifest, the miss being `apps/web build` ("'assets' removed from 'apps/web/public'").

Graph `orch-r3-v1.48.1` (`apps/web` and `apps/web/public` listings also excluded from the web build): cold run 39020698367 saved
(0/15, 1792 files, same sha256). Its warm run 39020942467 failed 14/15 with the same manifest, the miss being `apps/web build`
("'.vite-temp' removed from 'node_modules'") although `!node_modules` was in the entry.

Graph `orch-r5-v1.48.1` (exact-path exclusions of `node_modules/.vite-temp` and the temporary config file added): decoding the
saved web-build entry of cold run 39021703130 showed `node_modules/.vite-temp` and
`node_modules/.vite-temp/vite.config.ts.timestamp-…` as directly tracked inferred inputs, which `!node_modules` (an exact-path
negative) does not cover. Cold run 39022055258 saved (0/15, 1792 files, same sha256
`2e29f5eb56cd06a505a701192b7163381573276444e100031ae2e2e2aabfa65d`); its saved entry key carries the exclusions and its inferred
inputs contain no `vite-temp` path.

The earlier warm runs above are failures, not proof. A warm run passes only with 15/15 hits on a fresh runner and the cold run's
manifest; the result for the current graph is recorded on the pull request.
