# CI cache reuse investigation — 2026-10-22

Base: `af4c20724e1052359d5903ec70c5d17add6c2657`, current `origin/main` when this branch was created.
Scope: `fix/cache-reuse-ci-iteration`, existing Adea repository, cloud Linux x64,
Node 24.21.0, Bun 1.4.4, Vite+ 1.3.0, glibc 2.41. No task inputs, task dependencies,
test selections, shards, coverage thresholds, affected classification, or validation gates were changed.

## Two demonstrated persistence gaps

1. In [sample Build job 120098463947](https://github.com/adea-ai/adea/actions/runs/39857059604/job/120098463947),
   Detect Vite+ toolchain, Publish Vite+ cache contract, Cache Vite+ tasks and Save Vite+ task cache were skipped.
   The build then reported `0/15 cache hit`, `17/17 successful`.
   Code Foundry [v1.48.4 setup](https://github.com/0xPlayerOne/code-foundry/blob/6b1c536bec00b7044da91a15813e61d5d5063ce7/.github/actions/setup/action.yml)
   recognizes a literal `vp run` in the selected script; it does not follow
   `node scripts/vp-local-run.mjs orch:build`. Running its actual `script_uses_runner`
   function with `REPO_FOUNDRY_TASK=build` returns exit 1 for the base manifest, exit 0 for this branch.
2. Qualification saves under `production-tasks-v2-*`; validation restores under
   `vite-plus-v1-<OS>-<arch>-node<version>-bun<version>-vp<version>-*`.
   `gh api 'repos/adea-ai/adea/actions/caches?per_page=100'` returned 71 entries at inspection time:
   qualification archives existed on `refs/heads/main`, but no `vite-plus-v1-*` archive was present.
   The newest qualification archive was 4,659,115 bytes, with Bun 1.4.4, from run 39854712463.
   Main validation currently runs CodeQL rather than Build, and reusable PR validation cannot save this cache.
   Merely making the build recognizable would therefore leave the normal producer/reader gap open.

The manifest now dispatches CI directly to `vp run orch:build`; a local invocation retains the existing wrapper.
Any nonempty `CI`, including `false`, selects CI, matching the wrapper's existing truthiness rule. The task arguments,
inherited `VITE_CACHE_PATH`, and failures are preserved. The new routing tests failed against the base manifest
(4 passed, 5 failed), then passed after the fix.

After its existing independent cold/restored/warm output comparisons, the qualification workflow additionally saves
the qualified cache under validation's broad restore prefix. It uses exactly the setup action's two archive paths:

```text
node_modules/.vite/task-cache
**/node_modules/.vite/task-cache
```

The exact pattern list matters to Actions' archive version, even when different lists expand to the same files.
Executing the pinned setup's actual namespace and contract blocks locally confirmed both the namespace
`vite-plus-v1-Linux-X64-nodev24.21.0-bun1.4.4-vp1.3.0` and the path list above.
The publication is guarded by success, a `push` event, and the repository's default branch. PRs cannot publish it.
Existing qualification archives remain separate. The extra archive uses existing Actions storage, without new jobs,
permissions or credentials. Per-task file, environment and executable checks still decide whether anything can replay.

## Reproducible local replay

Use the pinned toolchain and run from the repository root. Choose a **new, empty** absolute cache directory outside
the checkout, and keep the logs/manifests outside it too. The clear command removes only graph-declared `dist` outputs.

```sh
export CI=true
export VITE_CACHE_PATH=/absolute/fresh-cache/tasks
bun install --frozen-lockfile
node scripts/vite-plus-proof.mjs --clear-outputs
bun run build > /absolute/fresh-cache/cold.log 2>&1
node scripts/vite-plus-proof.mjs --check-pass cold --log /absolute/fresh-cache/cold.log
node scripts/vite-plus-proof.mjs --print-manifest > /absolute/fresh-cache/cold.manifest
node scripts/vite-plus-proof.mjs --clear-outputs
bun run build > /absolute/fresh-cache/warm.log 2>&1
node scripts/vite-plus-proof.mjs --check-pass warm --log /absolute/fresh-cache/warm.log
node scripts/vite-plus-proof.mjs --print-manifest > /absolute/fresh-cache/warm.manifest
node scripts/vite-plus-proof.mjs --compare-manifest /absolute/fresh-cache/cold.manifest,/absolute/fresh-cache/warm.manifest
```

Observed here: cold `0/15`, warm `15/15`, both `17/17 successful`.
The fresh-output warm invocation took **1.413 seconds** measured with Python `time.monotonic()` around
`subprocess.run(['bun', 'run', 'build'])`. All 1,917 declared output files were restored.
The manifests were byte-identical, with SHA-256
`b6c932360cf2e711d628823841a7472cfaf3959a26f9d1aec36c3c788da9cdab`.
This proves local replay of the unchanged production graph, **not hosted end-to-end savings**.
The cold run also overlapped focused checks/lint, so its approximately 59-second wall is not a controlled timing baseline.

## Inputs, worktrees and sharding inspected

- `GLOBAL_INPUTS` still includes the lockfile, Bun configuration, both base tsconfigs, root tsconfig and Oxlint config.
  Every cached command still fingerprints executable bytes/versions, platform and libc through `ORCH_TOOLCHAIN`.
  Nothing was narrowed; configuration/lockfile changes intentionally remain conservative invalidators.
- Build/typecheck inputs still include transitive workspace `dist/**` and manifests; tests include transitive source
  and output trees. Existing dependency ordering, test preload inputs, Agent Sim pack digest and generated-path
  exclusions are unchanged. The graph/runtime tests cover the ordering, config extends and toolchain refusal contracts.
- The local wrapper still shares clean worktrees only at the same commit/environment and isolates dirty worktrees.
  CI and explicit cache-path overrides still bypass its directory/lock management. Web output still carries
  `ORCH_CHECKOUT`; cross-worktree web misses are intentional because its output embeds absolute paths.
  The new change does not claim cross-commit or cross-platform web portability.
- Required E2E remains eight native Playwright shards, one worker per shard, `fullyParallel: false`, with the
  event-listener probe on shard 1. Integration defaults to its complete inventory; its optional shard planner
  preserves the union and disjointness contract. No integration shard fan-out was enabled.
- In [sample E2E shard 8](https://github.com/adea-ai/adea/actions/runs/39857059604/job/120098464212),
  apt reported `Fetched 25.9 MB in 9min 32s (45.4 kB/s)`, while Playwright reported 41 passed in 1.8 minutes.
  Changing spec balance is not justified by that sample. Keep `install --with-deps` and all fonts/native libraries.
  The sample is not a green benchmark: Unit failed, shard 3 was cancelled, and the aggregate gate failed.

## Validation and limits

- Frozen install passed without a lockfile change. `code-foundry doctor` passed; its missing-hook warning was
  resolved by enabling the already-committed `.githooks` locally.
- `bun run build`: 17/17 successful; fresh-output replay and manifest comparison passed as above.
- `bun run lint`: 19/19 successful, zero warnings/errors. `bun run typecheck`: 33/33 successful.
- Final focused graph/runtime/local cache/proof/workflow/toolchain/integration inventory/E2E preparation/docs tests:
  **185 passed, 0 failed** across ten files, including eleven new routing/publication tests.
  Initial temporary-directory ownership failures disappeared with `TMPDIR` under the workspace; the cache safety
  checks were not relaxed. This container's `/tmp` is owned by an unmapped user.
- `bun run test:unit` **failed**, 29/31 task successes. Desktop reported 1,820 passed, 17 skipped and 9 failed;
  web fixture installation failed resolving the pinned Zod 4.6.5 tarball (`DNSResolveFailed`).
  The two desktop files containing the nine failures were also run directly on both branch and untouched base
  worktree: **14 passed, 9 failed** on each. Eight require the unavailable writable desktop profile location;
  the host-store test observes unexpected target permissions. No desktop source was edited.
- `bun run test:coverage` was run separately because the unit command stops before reaching it: **2,607 passed,
  2 failed**, 98.59% functions / 97.39% lines. Failures were the Compose process-group reap assertion and the
  installed-theme-copy guard (stale 0.122.3 UI/0.9.10 theme alongside current installed copies).
  Both files also failed in isolation on branch and untouched base: **39 passed, 2 failed** each.
  The existing 80% line/function thresholds remain intact; this lane is failed, not passed.
- Full database integration, browser E2E, packaged desktop and security audit were not rerun for this routing/storage
  patch. Their selection/gates remain intact; inventory/preparation contracts were checked. No skipped lane is a pass.
- No hosted cache save/restore was triggered from this draft. A successful default-branch qualification push must
  seed the compatible archive, followed by an affected required Build run that demonstrates the restore and hit count.
  Eviction, runner image/toolchain changes, source edits and the web checkout identity may legitimately reduce hits.

## Generator follow-up

No shared Code Foundry checkout or generated caller was edited. Its generator/runtime needs:

1. A supported way to declare wrapped/nested task-runner use. Integration/E2E wrappers also hide their internal
   dependency builds from setup's script matcher; do not cache their database/browser results to compensate.
2. A shared default-branch qualified-cache producer contract, so consumers need not repeat the pinned namespace and
   archive patterns. The new regression requires an explicit review when `runtime_ref` or toolchain pins change.
3. An independently measured browser preparation improvement that preserves full system dependencies. The sample's
   slow apt transfer does not justify removing dependency installation or increasing shards.

The live save/restore pair, all required green checks and review remain outstanding before merge. Auto-merge
must stay off. PR #1570's separate cache qualification files and the active provider/retention scopes were not edited.

## Visual failure follow-up at published cache head `4b93f035`

The coordinating owner marked #1581 ready; hosted Unit passed at that head. The earlier local unit/coverage
failures above remain historical environment receipts, not the hosted Unit result.
The [visual job in run 39862803468](https://github.com/adea-ai/adea/actions/runs/39862803468/job/120117511583)
failed the unchanged `conventional-workspace.spec.ts:3262` sidebar scenario:

- First attempt: the Virtual sidebar was absent at line 3373 after the narrow-layout view switch.
- Built-in retry: the 90-second test budget expired waiting for the toolbar's Expand contextual sidebar at line 3362.
- Workspace summary: 81 passed, 1 failed, 1 flaky. The flaky customization screenshot passed on retry; no baseline
  was refreshed. Chat then passed all 13 tests.
- Both failures logged trace/error-context paths, but the upload reported no files. The run's artifacts API returned
  an empty list. The later passing chat invocation had cleaned the same default `test-results` directory.

The bounded CI repair assigns `test-results/workspace` and `test-results/chat` to the respective invocations.
Their common ancestor remains covered by the existing failure upload. The shell still runs every applicable suite,
retains a failing suite's exit status and fails the same aggregate gate. No assertions, retries, time budgets,
baseline files, product source, lane-selection rules or cache changes were altered.

The new workflow-shell regression failed before this repair and passed afterward. An additional experiment with
the installed, real Playwright 1.63.0 CLI used browser-free fixture tests (workspace fails, chat passes): with one
output directory only the chat marker survived; with distinct directories both markers survived. Exit codes were
`[1, 0]` in both cases. `bun run test:e2e:visual --output=... --list` also confirmed Bun forwards the flag and all
83 workspace tests remain selected.

The sidebar's `isVisible()` branches immediately after resize/view switch are a synchronization hypothesis, not an
established cause. The shared component changes media state on mount/change and lazily loads its modal sheet;
without the lost hosted trace there is insufficient evidence to change its assertions or product behavior.
The exact unchanged scenario passed locally once normally (15.3 seconds) and once under 6x CPU throttling
(26.4 seconds), with zero retries. The diagnostic throttle was removed. Both used system Chromium
154.0.8037.57 against the unmodified dev server with an unreachable loopback database; these functional results
do not qualify the pinned visual renderer. Installing the pinned Chromium 153.0.8010.12 was blocked by HTTP 403
`Destination forbidden` from `cdn.playwright.dev`. No alternate download route or baseline update was attempted.

Open PR ownership was checked before edits: #1574 concerns scoped host rename/selection, #1570 owns separate cache
qualification files, and the open shared UI PR concerns packed WebKit diagnostics. None owns this workflow repair.
The failed test and its sidebar sources match this branch's unchanged main base. No product repair is claimed.
On the next authorized required visual run, retained workspace traces must establish the actual mobile transition
failure if it recurs; the missing artifact from the old run cannot be recovered by this patch.
