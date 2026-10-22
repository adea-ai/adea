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

The required Build script now exposes its CI `vp run` invocation to Code Foundry's setup matcher, while local builds
keep the shared-cache wrapper. The qualification workflow also publishes its verified outputs under validation's
restore namespace and exact archive path list on successful default-branch pushes. See the
[2026-10-22 investigation](evidence/ci-cache-reuse-2026-10-22.md) for the two demonstrated persistence gaps, local
fresh-output replay, failed broad checks, hosted-proof limitations and generator follow-up.

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

## Local shared cache

`bun run build` runs `node scripts/vp-local-run.mjs orch:build` instead of `vp run orch:build`. The wrapper picks the
directory `VITE_CACHE_PATH` names from the state of the checkout, outside every checkout:

```text
$ADEA_VP_CACHE_HOME (or $XDG_CACHE_HOME/adea-vp, or ~/.cache/adea-vp; absolute paths only)
  repo-<sha256 of the git common directory>/        clean checkouts of one repository
    head-<commit>/<environment key>/                clean: every clean worktree at that commit shares it
  checkout-<sha256 of the checkout path>/<key>/     local changes, untracked files or no commit: that checkout only
    state-changed/ or state-no-commit/
```

The environment key covers the Vite+ version, the Node version, platform and architecture, the bytes of `bun.lock` and
`vite.config.ts`, and the variables named `NODE_ENV`, `NODE_OPTIONS`, `BUN_*`, `VITE_*`, `ORCH_*` and `NPM_CONFIG_*`.
Changing any of them selects another directory, so the run starts cold and leaves the other state's entries alone; going
back to the first state replays its entries (A, B, A hits). Vite Task still fingerprints the files, declared variables and
`ORCH_TOOLCHAIN` of each task, so the directory only decides which entries are visible.

One platform never reads another platform's entries. The local environment key names the platform and the architecture, so
a macOS run and a Linux run of the same commit select different directories. The Actions task-cache key names the runner's
operating system and architecture (`${{ runner.os }}` and `${{ runner.arch }}`), so a hosted run never restores another
platform's archive. The shared R2 transport refuses a cross-platform entry for the same reason: the platform is part of the
toolchain identity its envelope carries, so an entry written on one platform is rejected on another rather than replayed.
That refusal is measured in
[the cross-machine and cross-platform transfer qualification](evidence/vp-r2-cache-transfer-qualification-2026-10-19.md).

Sharing across checkouts is limited to outputs that are portable. `apps/web build` is the only task whose output embeds the
absolute path of the checkout that built it (`dist/server/wrangler.json`, `dist/server/index.js`, and the TanStack Start
manifest, whose file name is a hash of its content). Its cached command therefore carries `ORCH_CHECKOUT`, a hash of the
checkout's canonical path (`scripts/orch-graph.mjs`, `checkoutIdentity`). A different checkout misses on that task and
rebuilds it under its own path; it never replays another checkout's path. Every other task keeps its command and its input
tracking, so its entries are shared across clean checkouts at one commit.

Each directory is created only after its components pass `ensurePrivateDirectory`: no component above the home may be
writable by group or others (sticky directories excepted), no component below it may be a symbolic link, owned by another
user, or writable by group or others, and the directory must be its own real path. A directory that fails these checks
is not used.

Two runs that start at the same time can reach the same missing component. The one that creates it wins the race, and
the other uses the directory the winner made and judges it by what it is, exactly as it judges a directory that was
already there. A concurrent first use therefore does not push a run off the shared cache.

Locking (`withLock`). A run takes `<directory>.lock`, published atomically, and records the process group it started at
`<directory>.lock.run`.

- A lock is reclaimed only when its owner has exited and no process group recorded by it still runs. A reclaimer takes
  `<directory>.lock.reclaim`, re-checks the exact bytes it read, removes the stale run record of that owner, and only then
  removes the lock. The stale lock excludes every successor until its run record is gone, so no successor's run record can
  be removed by a reclaimer.
- A run record present when a lock is newly acquired was left by something other than a clean release. It is kept byte for
  byte, the lock is released, and nothing runs; the run falls back to bypass. Removing the file by hand is the recovery once
  no build is running.
- The reclaim mutex is never broken by its age or by a guess about its owner. While it is held, the wait is bounded and the
  run fails with a message naming it.
- Malformed, symbolic-link, non-file or foreign lock and run records are refused and kept, and the run falls back to bypass.
  An empty lock file is refused at once; it is not read as owner 0.
- Every wait is bounded by the lock timeout (60 minutes). A process group that a dead owner recorded keeps the lock held
  until the group has gone.
- A lock that is released while another run is reading it is absent to that reader, not a failure. The reader waits for the
  lock again. The lock file's existence is what excludes a second holder, so a reader that finds the file gone waits rather
  than runs, and the run that created the lock is the only one that may hold it. The same holds for a run record that is
  released while it is read: the owner it describes is judged by its process, not by a file that is no longer there.

After the lock is acquired, the directory is planned again under the lock. If the commit, the cleanliness or the directory
changed while the run waited, nothing is launched against the shared directory: the run goes through bypass.

Bypass, with no environment change, no directory, no lock and no `--cache`: `CI` is set (the hosted lanes run the same
`vp run` as before), `VITE_CACHE_PATH` is already in the environment, the cache home is not absolute, the directory fails
the checks, the lock is refused, or the checkout changed while the run waited. Run the wrapper with `-- <vp run args>` for
other tasks.

Known limits:

- A reclaimer killed while it holds `<directory>.lock.reclaim` leaves that mutex behind. The runs that follow wait, then fail
  with a message naming it. Removing the file by hand is the recovery; the wrapper never removes it by age.
- One entry per task per directory. Worktrees at one commit whose ignored, generated files differ overwrite each other's
  entries. The `apps/web build` entry is rebuilt when `apps/web/test/fixtures/source-contracts/.runtime` (written by the
  test suite) is present in one worktree and absent in another.
- The `apps/web build` task fingerprints the repository root listing. Adding or removing a root file turns its replay into
  a miss. Keep scratch files outside the checkout.
- Cross-checkout replay of `apps/web build` is not done. That task is cached per checkout, so a second checkout rebuilds it.
- A run stopped with Ctrl-C stops `vp` after the tasks it has started; the wrapper then exits 130 and releases its lock.
  The entries written before the stop stay valid, and the next run fills in the rest.
- In bypass mode `vp` uses its own default cache under `node_modules`, as it did before this wrapper.

Possible future alternative (not implemented, not required for this scoped approach): make `apps/web build` path-free, or
exclude it from the cache, so that it too shares across checkouts. The per-checkout identity described above is the accepted
approach for now.

Receipts for the path-sensitive change (commit `0a18eff`, base `e7f19faa`):

- Writer checkout `proof-writer` at `0a18eff`, cold: 0/15 hits, 17/17 successful, `clean cache` in the shared directory.
  Warm: 15/15.
- Writer checkout deleted (`git worktree remove --force`, path absent).
- Second checkout `adea-vp-cache-b` at the same commit, after the writer was deleted, with its ignored `.runtime`
  fixture removed: cold 14/15 hits, 17/17 successful. The one miss is `apps/web build`, reported as
  `cache miss: env 'ORCH_CHECKOUT' changed, executing`. Warm: 15/15.
- The writer's checkout path appears in none of the second checkout's `dist` files. The second checkout's web build names its
  own path (2 files).
- The 14 portable packages' `dist` trees match the writer's byte for byte: 1681 files, `diff -r` empty, and the same
  sha256 over the sorted file list and contents (`d224c577…eb185c`).
- The web tree (210 files) differs from the writer's in five entries. After replacing the two checkout paths and the manifest's content
  hash in the file name, the same content remains in every entry, so the difference is the checkout path alone.

Full-suite diagnosis (`bun run test:unit`, same machine, nothing else running):

- Base `e7f19faa`, run 1: `test:coverage` exited 1 with 1720 passing and no failing test reported.
- Base `e7f19faa`, run 2: exited 1 with `a hung Compose down kills and reaps its owned process group` failing at
  `docker-pull-backoff.test.ts:277` (`groupExited` false). Passing in isolation: 36/36.
- Branch: the same test failed at the same line in its full run, and passes in isolation: 36/36.
- Cause, measured here: after the group is SIGKILLed, the stub is reparented to PID 1 (`process_api`), which reaped it
  1.57 to 1.71 seconds later in five of five trials. The test's reap budget is 1.5 seconds, and `groupHasExited` counts an
  unreaped zombie as a live member (`kill(-pgid, 0)` succeeds). The failure is therefore a race with the container's init
  under full-suite load, not a change in this code. It is recorded here and not fixed in this change.

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
manifest; the result for the current graph is recorded in
[the lane E cache and tooling receipt](evidence/vp-local-cache-lane-e-2026-10-20.md), in the section that holds the hosted
proof for the current graph.
