# Lane E: the local shared-cache lock, the pinned toolchain, and the last of Turbo

Repository `adea-ai/adea`. Base `333b948d4c5fba1f88d98d764c075b790be6ee22` (`Propose a rollback plan for the Railway
auth cutover, for root review (#1512)`), the tip of `origin/main` when this work started. Branch
`fix/vp-local-cache-lock-release-race`.

This receipt records what the caching and tooling lane repaired, what it measured before and after, what it
reconciled, and what it does **not** claim.

## 1. Scope

| File                                                      | What changed                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `scripts/vp-local-run.mjs`                                | a released lock is absent to the reader, not a failure; a component another run created is used, not refused       |
| `scripts/vp-local-run.test.ts`                            | the regressions for both, and the never-overlap proof at two scales                                                |
| `scripts/toolchain-pin.test.ts`                           | the guard that keeps the pinned Bun, Node and Vite+ versions, the native checker and the Actions cache key in step |
| `docs/vite-plus-proof.md`                                 | the locking and platform behaviour, as it is now                                                                   |
| `AGENTS.md`                                               | the pinned Bun version the instructions name                                                                       |
| `.oxlintrc.json`, `.gitignore`                            | the last live Turbo traces                                                                                         |
| `.agents/skills/turborepo/`, `.agents/.skill-lock.json`   | the Turbo skill this repository no longer uses                                                                     |
| `docs/evidence/vp-local-cache-lane-e-2026-10-20.md`       | this receipt                                                                                                       |
| `docs/evidence/cache-tooling-no-neon-proof-2026-10-20.md` | the no-Neon proof for the admitted scope                                                                           |
| `scripts/no-neon-cache-scope.test.ts`                     | the guard that holds it                                                                                            |

No dependency was added, removed or moved. `bun.lock` and `package.json` are untouched: the toolchain pins were already in
place, and they are now guarded rather than changed.

## 2. The dead-owner lock race

### 2.1 What happens

`readRegular` checks a lock or run record with `lstat` and then reads it. The owner of a lock removes it when its run
ends, so a reader can find the file with the check and read it after it is gone. The read then failed with `ENOENT`,
which is not a `LockRefused`, so it left `withLock` as an ordinary error: the wrapper printed its fixed failure category
and exited 1, although the lock had been released normally and the mutual exclusion had never been at risk.

The race is narrow. It needs the owner's release to land between the reader's check and its read.

### 2.2 The captured child stderr

Each child in the measurement runs the wrapper itself against one shared cache home, so the children contend for one
lock and each one can be the reader that loses the race. The child's own stderr is captured.

Before the repair, a child that lost the race wrote the wrapper's fixed category and exited 1:

```text
the command failed
```

and the child that lost the race had no more to say: the category is fixed, and it names no path and no raw message.

### 2.3 The evaluation: is a released lock "absent"?

The question the repair had to answer first was whether treating the vanished file as absent is correct, or whether it
would let two runs into the shared cache. It is correct, for three reasons that follow from how the lock is held:

- **The lock file's existence is what excludes a second holder.** A run publishes the lock with an atomic link
  (`tryCreate`), so at most one process can create it, and only the process that created it may run the work. A reader
  never gains the lock by reading it: reading only decides whether to wait, to reclaim a dead owner, or to give up. A
  reader that finds the file gone therefore waits again, and the successor that creates the file is the holder.
- **The reclaim path re-checks the bytes under the reclaim mutex.** `reclaimDead` removes a lock only when the bytes it
  holds are the bytes it observed and the owner is still dead. A lock that has been released in the meantime is not those
  bytes, so nothing is removed. The window between the check and the read cannot widen what a reclaimer removes.
- **The owner is judged by its process, not by its file.** `ownerState` asks whether the owner's process is alive first.
  A live owner is live whether or not its run record is still there, so a run record that is released while it is read
  cannot turn a live owner into a dead one.

The alternative - treating the vanished file as an error - makes a normal event (the owner releasing) fail the run with
exit 1 while nothing was wrong with the lock. That is a false failure, and it is what the measurement below caught.

### 2.4 The repair

`readRegular` maps `ENOENT` from the read to `null`, the same answer it gives for a file that was already absent. The
check stays in front of the read, because the check is what refuses a symbolic link before it is followed. A `beforeRead`
hook, in the same style as the hooks the module already had, lets a test remove the file in exactly that window.

### 2.5 The regression coverage

`scripts/vp-local-run.test.ts` covers each place a released file is read:

- `a lock that is released between the check and the read is absent, not a failure` - the reader waits and then runs.
- `a run record that is released between the check and the read leaves the dead owner dead` - the owner is judged by its
  process.
- `a lock that is released between the check and the read does not fail the release` - the run keeps its own result.
- `many processes contending on one directory never overlap, and none of them fails` - twelve children, each child's
  stderr captured and required to be empty, and the never-overlap assertion kept.
- `the wrapper, run as a child process under contention, exits zero, writes nothing to stderr and never overlaps` - six
  children run the wrapper itself against one shared cache home, and the work they start is shown to be serialised.

Each of the first three fails against the module as it was and passes against the repaired one; the same is true of the
two directory tests in section 3.

### 2.6 The measurement

The measurement runs the wrapper, or the lock itself, in child processes against one shared directory, so the children
contend for the same lock and every one of them can be the reader that loses the race. Each child's own stderr and exit
code are captured, and the children record when they enter and when they leave, so an overlap is visible in the record
rather than inferred.

**The lock itself** - 10,500 child runs in each phase, eight at a time, against the module as it was and against the
repaired one:

|                               | before | after  |
| ----------------------------- | ------ | ------ |
| runs                          | 10,500 | 10,500 |
| children that failed (exit 1) | **63** | **0**  |
| overlaps                      | 0      | 0      |
| wall clock                    | 235 s  | 256 s  |

The 63 failures are the race, and the child's own stderr names it exactly:

```text
Error: ENOENT: no such file or directory, open '.../cache.lock'
    at readFileSync (node:fs:483:20)
    at readRegular (.../vp-local-run.before.mjs:328:10)
    at withLock (.../vp-local-run.before.mjs:413:22)
```

`readRegular` at the read, called from `withLock` at the wait: the line the report pointed at. The mutual exclusion held
in every one of the 10,500 runs, before and after.

**The wrapper** - 1,500 child runs in each phase, each child running the wrapper itself against one shared cache home,
with a stand-in for `vp` in place:

|                               | before | after |
| ----------------------------- | ------ | ----- |
| runs                          | 1,500  | 1,500 |
| children that failed (exit 1) | **4**  | **0** |
| overlaps                      | 0      | 0     |
| wall clock                    | 306 s  | 298 s |

A child that lost the race wrote the wrapper's fixed category and nothing else, which is what the wrapper promises:

```text
the command failed
```

The rate is higher in this measurement than the two in ten thousand five hundred the report names, because the harness
holds the lock for a millisecond and releases it eight times over, which is the tightest release-to-read window the
wrapper can be put in. The rate is a property of the harness, not of the defect: what the measurement shows is that the
race is reachable, that it fails a run that had nothing wrong with it, and that the repair removes it.

## 3. The concurrent first use of the cache directory

The never-overlap proof above found a second defect, in the same file. Two runs that start at the same time reach the
same missing component of the cache home. The one that creates it wins, and the other lost the race with an `EEXIST` it
did not expect: the run gave up on the shared cache and ran `vp` without the lock, at the same time as a run that held
it.

That is what the eight-child run showed. A run that falls back to bypass does not write to the shared directory, so it
does not corrupt it, but it does run the same build at the same time as the run that holds the lock, and it loses the
cache it was going to use.

The defect was first seen in an eight-child run of the wrapper against a fresh cache home: three of the eight children
lost the creation race, ran without the lock, and overlapped the child that held it. The 1,500-child measurements above
did not hit it again - the race needs the children to reach the same missing component within the same moment - so the
deterministic regression, not the measurement, is what holds it.

The repair judges a component by what it is, not by which run made it: an `EEXIST` from the creation is followed by
another look at the component, and the component is then checked exactly as a component that was already there is
checked. A component another run created that is writable by group members is still refused.

## 4. The reconciliation

### 4.1 The last live Turbo traces

Turborepo was replaced by Vite+ in #1433, and #1441 recorded the cutover. What was left behind was configuration, not
history:

| Trace                                         | What it was                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `.oxlintrc.json` `ignorePatterns` `.turbo/**` | an ignore path for a cache directory no task writes any more                         |
| `.gitignore` `.turbo/` (twice)                | the same ignore, in a file that carries two copies of its rules                      |
| `.agents/skills/turborepo/`                   | a skill that tells an agent to run `turbo run` and to register tasks in `turbo.json` |
| `.agents/.skill-lock.json` `turborepo`        | that skill's entry in the locked set                                                 |

The skill is the one that mattered: it contradicts this repository's own ADR 0015 and would have an agent reintroduce
the runner this repository removed. It is removed here, and its entry is removed from the locked set with it. The same
shared skill set still exists in the other repositories of the fleet; that is the skill set owner's decision, not this
lane's, and it is recorded here rather than changed there.

The historical records were not touched: `CHANGELOG.md`, the `docs/evidence/**` receipts that quote Turbo tasks, and ADR
0015's own account of the cutover stay exactly as they were. `turbo_remote: false` in `.github/code-foundry.yml` stays
as well: it is part of the generated Code Foundry configuration that the repository's managed instructions describe, and
removing it would change what the generated callers do.

### 4.2 The pinned Bun, the native checker, the classic API and the configuration

The consolidation is already in the repository: `package.json` pins `bun@1.4.3`, every workflow installs Bun 1.4.3, the
mise tools pin Bun 1.4.3 and Node 24.21.0, the workspace packages check with the native checker (`bun check`) and keep
their declaration emit on `tsc`, and the TypeScript 6 classic API stays as the pinned `typescript6` alias for AST
compatibility. What was missing was a guard, and the repository's own instructions had drifted: `AGENTS.md` still said
`package.json` pins Bun 1.4.0.

`scripts/toolchain-pin.test.ts` is that guard. It reads the committed configuration only - the manifest, the mise
tools, the workflows, the instructions and the workspace manifests - and it holds these together:

- every workflow installs the pinned Bun version, and the pinned Node version or a range of the same major;
- the instructions name the pinned Bun version, so the drift that happened cannot happen again;
- every workspace package that type checks does it with the native checker, and no package calls `tsc` to check;
- every library that builds keeps its declaration emit on `tsc`;
- the Actions task-cache key names the pinned Bun, Node and Vite+ versions, and names the runner's operating system and
  architecture, and its restore prefix is that key without the run that wrote it.

The key guard matters for the cache, not only for the pin: a key that named a Vite+ version the repository no longer
pins would restore an archive written by a different task runner.

### 4.3 The #1497 state-directory mkdir failure, redaction and fail-closed outcome

The probe's own test is in `origin/main`, from the merged #1497 (`761de9982`): `apps/desktop/tests/packaged-native-auth-probe.test.ts`,
`a state directory that cannot be prepared is a fixed, path-free outcome`. It makes the state directory fail to be
prepared, and it requires three things: the probe does not throw, the verdict is the fixed `failed_data_directory`, and
the verdict does not contain the path that failed. The redaction of the same failure in the serialized probe is covered
next to it.

This lane does not repeat that test. The follow-up tasks that were queued against it are satisfied by the merged code.

### 4.4 The cross-platform proof

| Boundary                | Where it is proved                                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the local shared cache  | the environment key names the platform and the architecture, so two platforms select two directories and neither can read the other's entries                                                                              |
| the Actions task cache  | the key names `${{ runner.os }}` and `${{ runner.arch }}`, so a hosted run never restores another platform's archive; `scripts/toolchain-pin.test.ts` holds the key to the pins                                            |
| the shared R2 transport | the platform is part of the toolchain identity the envelope carries, so an entry written on one platform is refused on another; measured in [the transfer qualification](vp-r2-cache-transfer-qualification-2026-10-19.md) |

What is **not** proved for this repository: a Windows build of the production graph. This repository's runner profile is
Linux only (`.github/code-foundry.yml` and every workflow name `ubuntu-latest` or `ubuntu-slim`), and the campaign's
Windows receipts belong to another repository, not to this one. Closing that gap needs a `windows-latest` leg in the
qualification workflow, which is a CI cost decision and a workflow-file scope decision; it is recorded for the owner
rather than taken here.

### 4.5 What each of the three caches proves

| Behaviour    | Local shared cache (`scripts/vp-local-run.mjs`)                                                                                                            | Actions task cache (`.github/workflows/task-cache-qualification.yml`)                                                    | Shared R2 transport (`scripts/vp-r2-cache*.mjs`)                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| key          | the environment key covers the commit, the Vite+, Node, Bun, platform and architecture versions, the lockfile, the config and the build-relevant variables | the key names the runner's platform and architecture, the pinned Bun, Node and Vite+ versions, and the run that wrote it | the transfer identity is the digest of the canonical envelope with the creation time blanked, over the trust domain |
| invalidation | another commit, another platform, another toolchain or another variable selects another directory                                                          | a different key is a miss; the restore prefix replays the newest entry of the same inputs                                | a different toolchain, platform or namespace is refused as a compatibility mismatch                                 |
| miss         | a checkout with local changes, untracked files or no commit uses a directory of its own                                                                    | the first run on a fresh runner is a miss and is asserted to be one                                                      | a store that holds no entry for the key is a refusal, not a silent success                                          |
| failure      | a refused lock, a refused directory, a foreign lock record and a changed checkout all fall back to the plain `vp run`                                      | a failed build is never saved                                                                                            | a store that never answers ends in a timeout fallback and the target keeps its local cache                          |
| corruption   | the wrapper never parses the cache: the directory holds Vite+'s own entries, and the wrapper only chooses which of them are visible                        | the archive carries its own digest                                                                                       | a changed archive is refused by its digest, and an envelope of an unknown version is refused                        |
| concurrency  | the lock and the directory creation are proved under contention, and the never-overlap assertion is kept                                                   | the key is per run, so two runs never write the same entry                                                               | one deadline and one signal cover the publication, the lookup and the reads                                         |
| platform     | the key names the platform and the architecture                                                                                                            | the key names `${{ runner.os }}` and `${{ runner.arch }}`                                                                | a cross-platform entry is refused                                                                                   |

### 4.6 The current-head local cache qualification

The qualification below was measured at the published head `a5f2245a634f7b87d537eef952b17668007ed4f3`, with three
**independent worktrees** of this repository at that commit, each with its own checkout path and its own
`bun install --frozen-lockfile`. The task is `orch:types:build` of the real graph - a portable output, so a replay can
be compared byte for byte. The cache home is a directory of its own, outside every checkout.

| Worktree | State              | Mode      | Directory                                                          |
| -------- | ------------------ | --------- | ------------------------------------------------------------------ |
| A        | clean              | `clean`   | `<home>/repo-<git common dir>/head-a5f2245a6.../<environment key>` |
| B        | clean              | `clean`   | **the same directory as A**                                        |
| D        | one untracked file | `working` | `<home>/checkout-<checkout path>/state-changed/<environment key>`  |

**Independent clean-worktree reuse.** A ran first and was cold; B, a separate checkout at the same commit, reused
A's entry:

| Run                                   | Plan the wrapper printed                                                | Hit     | Exit |
| ------------------------------------- | ----------------------------------------------------------------------- | ------- | ---- |
| A, the first clean worktree           | `clean cache (clean checkout, shared by the repository at this commit)` | 0/1     | 0    |
| B, the second clean worktree          | `clean cache (clean checkout, shared by the repository at this commit)` | **1/1** | 0    |
| B again, after the dirty worktree ran | `clean cache (clean checkout, shared by the repository at this commit)` | **1/1** | 0    |

The two worktrees' `packages/types/dist` trees are the same bytes: 586 files each, the same sha256 over the file
list and their contents, `44c050b902e7db82333c23338b052091af04e71dfd017a7eeab21c3f5cc9949a`. The shared directory is
outside every checkout.

**Dirty-state isolation.** D carries one untracked file, so it selects a directory of its own and never the shared
one:

| Run                          | Plan the wrapper printed                           | Hit | Directory |
| ---------------------------- | -------------------------------------------------- | --- | --------- |
| D, the dirty worktree, first | `working cache (local changes or untracked files)` | 0/1 | its own   |
| D, the dirty worktree, again | `working cache (local changes or untracked files)` | 1/1 | its own   |

D's first run was a miss while the clean worktree's entry existed and was being reused, so D did not see the shared
entry; D's second run hit its own. The shared entry was untouched by both dirty runs: B still hit it afterwards. The
two directories each hold their own task cache, and the dirty one is a different path.

**Concurrent lock behavior at this head.** The file the concurrency measurement used is byte-identical to the file at
this head, so the measurement in section 2.6 is the measurement of this head and was not repeated:

```console
$ shasum -a 256 scripts/vp-local-run.mjs
051facd3436b5e9f58927bd93b35087c6d555abc66337c496329314fcf638811  scripts/vp-local-run.mjs
$ git log --oneline 6bf18976b..HEAD -- scripts/vp-local-run.mjs
(no output: the file has not changed since the measured commit)
```

The lock's own suite at this head is **67 pass, 0 fail** (295 assertions), and it includes the thirteen tests that
start child processes: twelve children contending on one directory, six children running the wrapper itself against
one shared cache home, and the group cases. The never-overlap assertion is asserted in full in each of them.

**What this qualification is not.** It is one task of the real graph, on one machine, with a cache home of its own. The
whole-graph reuse of an earlier head is the receipt in `docs/vite-plus-proof.md` (the writer and reader pair at
`0a18eff`), and the hosted graph receipts there are at the heads they name. Nothing here claims a hosted run, a
production timing, or a graph-wide result.

### 4.7 The successor qualification: the real graph at the current main

The qualification in 4.6 covers one package task at a head that has since been merged into main. This one covers the
**real graph** at the main that is current now, and the two isolation dimensions 4.6 does not cover: a **tracked**
modification, and a **different build-relevant environment** at the same commit.

Four independent worktrees of this repository at `d55f485000e294db511fd70fd412c568ca7c46fe` (the tip of `origin/main`
when this was measured), each with its own checkout path and its own `bun install --frozen-lockfile`, and a cache home of
its own outside every checkout. The task is `orch:build`: 15 cacheable tasks, 17 tasks successful.

| Run                                      | Directory the wrapper selected                        | Hit       | Tasks | Exit |
| ---------------------------------------- | ----------------------------------------------------- | --------- | ----- | ---- |
| A, the first clean worktree              | `repo-<git common dir>/head-d55f48500.../4dc7a7cb...` | 0/15      | 17/17 | 0    |
| B, the second clean worktree             | the same directory                                    | **14/15** | 17/17 | 0    |
| B again, after the other runs            | the same directory                                    | **15/15** | 17/17 | 0    |
| D, a tracked modification                | `checkout-<checkout path>/state-changed/4dc7a7cb...`  | 0/15      | 17/17 | 0    |
| B again, after the dirty run             | the same directory                                    | **15/15** | 17/17 | 0    |
| E, a clean worktree, another environment | `repo-<git common dir>/head-d55f48500.../fb6fdefc...` | 0/15      | 17/17 | 0    |
| B again, after the other environment     | the same directory                                    | **15/15** | 17/17 | 0    |

**Independent clean-worktree reuse on the real graph.** The second clean worktree reused the shared entries: 14 of the
15 cacheable tasks hit. The single miss is the one the design names: `apps/web build` is the only task whose output
embeds the absolute path of the checkout that built it, so it is keyed per checkout and is rebuilt under the second
worktree's own path. The **14 portable packages' `dist` trees are the same bytes** in both worktrees, and `apps/web` is
the only package that differs. After the second run, its own web-build entry exists, and the next run of B is 15/15.

**Dirty-state isolation, by a tracked modification.** 4.6 isolated a checkout by an untracked file; this one changes a
tracked file. The worktree selected a directory of its own, `checkout-<path>/state-changed/...`, and was a **miss while
the shared entry existed and was being reused** - it never saw the shared entries. The shared entry was untouched: B hit
15/15 afterwards.

**Environment-key isolation.** A clean worktree at the _same commit_ with one more build-relevant variable
(`VITE_QUALIFICATION_PROBE`) selected a _different_ directory under the same commit - `fb6fdefc...` instead of
`4dc7a7cb...` - and was a miss, while the plain environment's directory kept its entry (B hit 15/15 afterwards). The
environment key, not only the commit, is what separates the entries.

**The concurrency measurement was not repeated.** The file it used is byte-identical to the file in current `main`:

```console
$ git show origin/main:scripts/vp-local-run.mjs | shasum -a 256
051facd3436b5e9f58927bd93b35087c6d555abc66337c496329314fcf638811  -
```

so the 10,500-run measurement in section 2.6 already describes the lock code this main runs, and the current-head
suite holds the child-process proofs.

**What this qualification is not.** It is one machine, one cache home and no hosted runner. It claims nothing about
timings under load, nothing about a hosted restore, and nothing about a cutover.

## 5. What was run

Host: macOS 14 (darwin-arm64), Node 24.21.0 and Bun 1.4.3 from the repository's pinned toolchain. The numbers
below were measured on the cache and tooling branch `fix/vp-local-cache-lock-release-race` at `15f64d5db` and
`a5f2245a6` (the repair, the reconciliation, the no-Neon proof and the child-process timeouts); the successor
qualification in section 4.7 was measured at the current main `d55f485000e294db511fd70fd412c568ca7c46fe`.

| Command                                                                                                                                                                                 | Result                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun test scripts/vp-local-run.test.ts`                                                                                                                                                 | **67 pass, 0 fail**, 295 assertions                                                                                                                                            |
| `bun test scripts/toolchain-pin.test.ts`                                                                                                                                                | **10 pass, 0 fail**, 81 assertions                                                                                                                                             |
| `bun test scripts/no-neon-cache-scope.test.ts`                                                                                                                                          | **10 pass, 0 fail**, 510 assertions                                                                                                                                            |
| `bun test scripts/vp-local-run.test.ts scripts/toolchain-pin.test.ts scripts/no-neon-cache-scope.test.ts`                                                                               | **87 pass, 0 fail**, 886 assertions                                                                                                                                            |
| `bun test scripts/vp-local-run.test.ts scripts/toolchain-pin.test.ts scripts/no-neon-cache-scope.test.ts scripts/docs-boundary.test.ts scripts/no-neon-ci.test.ts` (at the merged head) | **107 pass, 0 fail**, 1,119 assertions                                                                                                                                         |
| `bun test scripts/*.test.ts` (the root scripts lane)                                                                                                                                    | **1,009 pass, 0 fail**, 10,174 assertions, 77 files (one re-run: a five-second timeout in `scripts/evidence-manifest.test.ts`, another lane's test, which passes in isolation) |
| `bun run test:coverage` (the aggregate coverage lane)                                                                                                                                   | **2,096 pass, 0 fail**, 20,013 assertions, 154 files; 98.36% functions and 97.97% lines against the 80% goal; `scripts/vp-local-run.mjs` at 92.86% functions and 96.38% lines  |
| `vp run orch:test` (the aggregate unit lane)                                                                                                                                            | **32/32 tasks successful**, 0 failing tests                                                                                                                                    |
| `bun run build`                                                                                                                                                                         | **17/17 tasks successful**                                                                                                                                                     |
| `bun run format:check`                                                                                                                                                                  | clean over 2,914 files                                                                                                                                                         |
| `bunx oxlint --deny-warnings`                                                                                                                                                           | exit 0, no warning and no error                                                                                                                                                |
| `bun run typecheck` (the pre-commit gate)                                                                                                                                               | **33/33 tasks successful**, no type errors in 324 files                                                                                                                        |
| `bun test scripts/docs-boundary.test.ts`                                                                                                                                                | **4 pass, 0 fail**                                                                                                                                                             |

Each new regression was run against the module as it was, and fails there:

| Regression                                                                              | Against the module as it was                                           |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| a lock that is released between the check and the read is absent, not a failure         | fails: `ENOENT` leaves `withLock`                                      |
| a run record that is released between the check and the read leaves the dead owner dead | fails: `ENOENT` leaves `withLock`                                      |
| a lock that is released between the check and the read does not fail the release        | fails: the release throws over the run's result                        |
| a component another run created at the same time is used, not refused                   | fails: `EEXIST` leaves `ensurePrivateDirectory`                        |
| a component another run created at the same time is still judged by what it is          | fails: `EEXIST` leaves `ensurePrivateDirectory`                        |
| the instructions name the pinned Bun version                                            | fails: the instructions named Bun 1.4.0                                |
| the admitted scope names no Neon service                                                | fails: a `NEON_AUTH_BASE_URL` comment in the transport trips the guard |

Two aggregate runs were re-run rather than reported as they landed, and what they showed was the same thing both
times: the tests that start child processes were on the runner's five-second default, and the wait grows with
the load of the host. Four other fleet workers were building and testing on the same machine. The first full
scripts lane lost `scripts/theme-color-boundary.test.ts`, the first coverage run lost
`scripts/evidence-manifest.test.ts` and `scripts/integration-runner-lifecycle.test.ts`, and a later run lost this
lane's own wrapper contention test, which was killed at five seconds with two of its children killed with it.

The fix was in this lane's own file and only in this lane's own file: the thirteen tests that start child processes
now have a timeout of their own, so a loaded host does not decide the result. **No assertion changed, and the
never-overlap assertion is still asserted in full**: the children still have to exit zero, still have to write
nothing to their stderr, and their work still has to be shown to be serialised. The tests of other lanes that
timed out pass in isolation (17, 43 and 89 tests) and were not touched.

One task of the aggregate unit lane also failed for a reason outside the repository: the Vite+ runtime's staged
Bun package in this session's runtime directory was missing its `bun.native` binary, so the launcher could not
exec it and the desktop task exited 126 before it ran a test. The incomplete staged package was removed so the
runtime could re-stage it, and the task then passed whole (1,829 pass, 7 skip, 0 fail across 141 files). No
repository file changed for it.

the same environment limit the campaign receipts record. The lane completed: those tests handle the pull failure
themselves, and the run passed with 0 failures.

## 6. What is not claimed

- No hosted run was made. Every measurement in this receipt is local, on one machine, against a synthetic stand-in for
  `vp` and an injected cache home. No cache, credential, secret, permission or service was touched, and the shared R2
  transport stays off: nothing in `package.json` or in any workflow names `ADEA_VP_R2_CACHE_ENABLED`.
- No claim is made about the production cost or the speed of the shared cache. The receipt counts failures and overlaps.
- The Windows build of the production graph is not proved here, and the receipts of the campaign that quote Windows runs
  are about another repository.
- The efficiency candidate the campaign records as remaining - a production build on Bun instead of `tsc` - is not taken
  here. It needs an exact-head review, a hosted validation and a rollout decision, and it changes what is published.

## 7. Coordination and handoff

- **Railway is the sole target.** The no-Neon proof for this lane's admitted scope is
  [the cache and tooling no-Neon proof](cache-tooling-no-neon-proof-2026-10-20.md): the thirteen files the lane owns
  name no Neon service, package, variable or host, no database service at all, and no repository secret, and the
  R2 transport is off and falls back to the caller's own local cache. There is no Neon fallback, compatibility path or
  rollback in the scope; the recovery is a Railway backup/restore or a forward fix. The one Neon trace in this lane's
  own tooling surface - the coverage lane's list naming the auth driver's `neon-driver.test.ts` - is routed to that
  test's owner rather than removed here, because taking it out of the list would weaken a gate another lane owns.
- **Lane F** (CI and release compatibility) routes product and cache defects to their single owner. No cache or lock
  defect was reported to this lane. This lane owns `scripts/vp-*.mjs`, `scripts/vite-plus-proof.mjs`,
  `scripts/orch-*.mjs` and the cache lanes of `.github/workflows`; a CI or release file that F needs is not changed here.
- **Lane H** (efficiency and no-Neon dependency audit) measures and audits. The cache and tooling scope holds no active
  Neon coupling: the only match for "neon" in it is the file name of a test in the coverage lane's list, which is
  recorded for the owner of that test. The repository-wide inventory of the traces this lane does not own is in
  section 5 of the no-Neon proof, so the audit has the map without a second sweep.
- The two repairs in this branch are in the shared cache's lock and directory code. A run that uses the shared cache on
  one machine is affected by them, so any measurement lane that runs builds concurrently should read this receipt before
  it compares timings.
