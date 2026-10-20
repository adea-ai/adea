# Cross-pull-request coordination — exact heads, logs, failure map

Branch: `codex/20261020-ci-release-w7`. Base: `origin/main` =
`333b948d4c5fba1f88d98d764c075b790be6ee22`. Read on 2026-10-20 from repository
reads and check-run reports only. No live system was read, no branch was
created, pushed or deleted, and no release, deploy, readiness or merge was
performed.

This is the coordination record for the pull requests in this session's scope:
the four in this repository and the two Control Plane ones. It states the exact
head each one is at, what its logs say, and where it stands.

## The heads

| Ref                                                            | Repository              | State           | Exact head                                 | Merge commit                               | Merged at            |
| -------------------------------------------------------------- | ----------------------- | --------------- | ------------------------------------------ | ------------------------------------------ | -------------------- |
| #1486 `test/desktop-packaged-scheme-target-proof`              | `adea-ai/adea`          | merged          | `3eaf0e45838e2b2ac805680702c0fb63b878a4af` | `4505c88473e1d29b4df67497c6561974d05378df` | 2026-10-19T19:28:50Z |
| #1509 `test/packaged-lane-failure-summary-regression-20261019` | `adea-ai/adea`          | open, not draft | `adc16c1ebc90189d580c1df690b2d3f5bc71264e` | —                                          | —                    |
| #1512 `docs/railway-cutover-rollback-plan`                     | `adea-ai/adea`          | merged          | `7a3c423928a8c9d415b3cba0ca471c3d0158f7a4` | `333b948d4c5fba1f88d98d764c075b790be6ee22` | 2026-10-20T06:33:57Z |
| #1513 `docs/journey-child-operation-readme`                    | `adea-ai/adea`          | merged          | `4a379f75a9968509feffbc90ef53e1c2ff6ab23d` | `2ca042b9cf6ecc7e983331827f0721cf0ac1a2ee` | 2026-10-20T06:27:56Z |
| CP #1202 `claude/pi-1173-child-outcome-contract`               | `adea-ai/control-plane` | merged          | `efa3d8e9307cc2f0f1739b1d794634104099f815` | `79a31ddd04b58c3a15dfb0022340c9ddf05cfb6b` | 2026-10-20T06:28:02Z |
| CP #1048 `feat/profile-recovery-rollback-1025`                 | `adea-ai/control-plane` | open, draft     | `e635101384587b6d9e66dd6d1dbfb0eec8666883` | —                                          | —                    |

Auto-merge is off on every one of them: the pull-request records report no
auto-merge request.

## The self-hosted auth lifecycle qualification

The pull-request lanes prove a **self-hosted** auth lifecycle against a real
database, and a skipped run is never read as a proof of it.

`packages/auth/tests/integration/better-auth-postgres.test.ts` is the suite. It
creates an isolated schema, applies the provider migrations, signs a user up,
reads the session back from the persisted row, revokes the session, and proves
the persisted session is gone. It skips itself when `AUTH_POSTGRES_TEST_URL` is
absent — and in CI, until this change, it always skipped: the integration
runner never supplied the variable, so the lane's green result said nothing
about the lifecycle.

### What the qualification does

`scripts/self-hosted-auth-lifecycle.ts` runs the suite with the variable
supplied and refuses a run that proved nothing:

| Condition                                                       | Outcome                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| the suite fails                                                 | the lane fails, with the failing lines and no credential in them |
| the suite reports a skipped case                                | the lane fails: a skipped run is not a proof                     |
| the suite reports no passing case                               | the lane fails: a skipped run is not a proof                     |
| the URL is not a loopback PostgreSQL with a role and a password | the lane fails before the suite runs                             |

The suite runs in a minimal environment — its one URL plus `PATH`, `TMPDIR` and
`LANG` — so a value in the caller's environment cannot change what the
lifecycle proves.

### Where it runs

The integration runner owns the instance it starts, so it hands the
qualification that instance's loopback administrative URL
(`scripts/test-integration.mjs`). The lane's log records that the lifecycle was
proven. A run against an explicitly supplied target owns no loopback instance,
so the lane says the lifecycle was **not** proven there rather than claiming
it.

The variable is deliberately not part of the sweep's environment. That was
measured, not assumed: with the variable supplied to the whole sweep, the
backup-and-restore suite — which shares the variable — runs against the
Compose instance and refuses it, because that suite needs a
certificate-verified TLS connection with the instance's own pinned certificate
and a Compose instance has no TLS. The lifecycle suite needs no TLS; the sweep
must not be handed a URL another suite would refuse.

### Evidence

On a local disposable loopback PostgreSQL 18, macOS arm64, Bun 1.4.3, Node
24.21.0, 2026-10-20:

| Run                                                                                                                                                    | Result                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun --no-env-file test --conditions=react-server packages/auth/tests/integration/better-auth-postgres.test.ts` with `AUTH_POSTGRES_TEST_URL` supplied | **1 pass, 0 fail, 7 assertions**                                                                                                                     |
| the same suite with the variable absent                                                                                                                | 0 pass, 3 skip — the skip the qualification refuses                                                                                                  |
| `bun scripts/test-integration.mjs` (the local instance, port 55499)                                                                                    | the migration verification passed (60 applied migrations) and the lane logged `the self-hosted auth lifecycle was proven against the local instance` |

The two neighbouring suites that share the variable were measured too, so the
handoff below is based on what they need rather than on a guess:
`request-path-delivery.test.ts` passes (7 pass) and `schema-init-postgres.test.ts`
passes (14 pass) against the same loopback administrative URL, and
`schema-backup-restore.test.ts` fails it with `the target sslmode is not
accepted`.

### The handoff to the lane that owns the disposable proof

The qualification is a module with no dependency on any runner, so the lane
that owns the disposable PostgreSQL proof can call it from its own proof and
gain the same fail-closed lifecycle against its certificate-verified instance.
This lane did not edit that lane's files: the module is offered, and the call
site is theirs to make.

## Coordination with the efficiency lane's pull request (#1515)

`#1515` (`chore(neon): remove the provider coupling from the runtime and the
deployment`) and this lane both touch the same paths. The overlaps, and what
happens to each:

| Path                           | `#1515`                                                                                                                | This lane                                                                | Resolution                                                                                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/database-config.mjs`  | removes the provider-specific host rule and replaces it with a stronger, provider-neutral "one host and one port" rule | had edited the same file                                                 | **this lane reverted its edit.** The path belongs to `#1515`; its rule is strictly stronger and names no provider. This lane carries no diff for the file, so there is no conflict and no second claim.          |
| `README.md`                    | rewrites the CI paragraph, keeping the two-shard, isolated-branch, `Migrate Neon Branch` wording                       | rewrites the same paragraph to describe the disposable proof             | **this lane's wording is the accurate one** after the workflow change, and `#1515`'s text describes a lane that no longer exists. The two overlap in one hunk; whoever rebases last takes the accurate sentence. |
| `docs/database-operations.md`  | rewrites the topology table and the production-role history                                                            | rewrites the pull-request CI section and adds the auth lifecycle section | Different hunks: no conflict.                                                                                                                                                                                    |
| `apps/web/CLOUDFLARE.md`       | rewrites the preview and Hyperdrive sections                                                                           | corrects the preview-branch bullet                                       | Different hunks: no conflict.                                                                                                                                                                                    |
| `scripts/test-integration.mjs` | one comment line                                                                                                       | the auth lifecycle wiring                                                | One line of overlap: the comment. Trivial.                                                                                                                                                                       |

The one provider identifier this lane no longer owns is
`scripts/database-config.mjs`'s `.neon.tech` rule, and `#1515` removes it. The
no-Neon proof records that ownership explicitly rather than editing the file:
`scripts/no-neon-ci.test.ts` asserts the path is **not** in this lane's scanned
set, and names the identifier and the pull request that removes it.

### The proof's lifecycle, and the combined state

The proof used to require that identifier to still be there. That was the
wrong contract twice over: it made this lane's test fail when the other lane
did its work, and it made a provider identifier a _requirement_ of a no-provider
proof. The contract is now the one that is true in both states:

- a path this lane owns may not name a provider identifier;
- a path another lane owns may name **exactly** the identifier its record
  names — the record names it, so a new identifier there still fails;
- nothing requires the recorded identifier to still be present.

### The two surfaces, and the negative control

The proof has to hold in two states: the one where the provider marker is
present, and the one where it is gone. The owning lane's approved change takes
the repository from the first to the second, so a proof that reads the marker
out of that lane's file fails the moment the removal lands.

Neither surface is read out of the owning lane's file any more:

| Surface                | How it is built                                                                           | What the scan must find             |
| ---------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------- |
| **pre-removal**        | a **controlled fixture** that injects the provider marker into a copy of the current file | the marker, in the owned path       |
| **post-removal**       | a copy of the current file with the marker taken out                                      | only the two documented refusals    |
| **the actual surface** | the repository as it is                                                                   | no identifier that no record allows |

The pre-removal surface is a fixture rather than a copy of the current file, so
the negative control does not depend on the marker still being there. That is
the whole point of the control: it proves the scan is sensitive, and it keeps
proving that after the removal lands.

The control was checked three ways on 2026-10-20:

| Check                                                                                                                     | Result                                                        |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| the qualification in the repository as it is                                                                              | **14 passed, 0 failed**, 187 assertions                       |
| the qualification in the post-removal surface, with the other lane's **pushed** file `7fa24f2ee` substituted in           | **14 passed, 0 failed**, 186 assertions                       |
| the qualification in the post-removal surface, with the other lane's **in-progress local** file `89e020b3` substituted in | **14 passed, 0 failed**, 186 assertions                       |
| a mutation check: a scan that detects nothing at all                                                                      | all three lifecycle cases fail, so the control is not vacuous |

The other lane's file was not edited, no provider was restored, and detection
was not weakened: the marker is still found wherever it appears, and a marker
the records do not name still fails.

The disposable copy is not the only witness. The other lane's **actual pushed
bytes** were compared read-only on 2026-10-20, at
`origin/codex/20261020-efficiency-audit-w8` = `7fa24f2ee991d672cb6ed1373b63f125a6e206e1`:

| Check                                                             | Result                                                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| provider identifiers in that lane's `scripts/database-config.mjs` | **none**                                                                                                                                 |
| the whole CI surface with that file substituted in                | the only provider identifiers left are the two documented refusals, `NEON_AUTH_BASE_URL` in `scripts/test-target-guard.mjs` and its test |

Both routes agree with the disposable copy's result, and the copy is what the
test asserts, so the proof does not depend on the other lane's branch being
present in a checkout.

The same read-only comparison was run again against that lane's in-progress
local head `89e020b32631ecba72bf390bb34b623082cc1be2` (unpushed at the time),
and the result is the same: the whole surface with that file substituted in
leaves only the two documented refusals.

### A pull-request description mix-up, found and repaired

Two lanes wrote their pull-request description to the same shared temporary
file and then edited their pull request from it, so each lane's description
briefly held the other lane's text. This lane's description is back to its own
text, and the other lane's description was restored to the text that lane had
written, with a note on that pull request so its owner can re-apply a newer
version if there is one. No commit, branch or file of any other lane was
touched, and the repair is a description, not a change to any work.

## #1509 — the failing Unit/Validation result, verified

### The failure

Run `39355828916` on `adc16c1eb`, 2026-10-20T01:52:29Z. Two checks failed and
everything else passed (33 reported, 2 failed):

| Check                      | Result      | Job            |
| -------------------------- | ----------- | -------------- |
| `Validation / Test / Unit` | fail (3m9s) | `118410300127` |
| `Validation / Gate`        | fail (7s)   | `118412029687` |

`Validation / Gate` is the aggregate: it reports `test: failure` because the
unit task failed. It is not a second defect.

### The log

The unit job's log ends with the whole test run green and the task red:

```
 1916 pass
 0 fail
 18755 expect() calls
Ran 1916 tests across 145 files. [48.02s]
error: script "test:coverage" exited with code 1
error: script "test:unit" exited with code 1
```

Zero failing tests and a nonzero exit is the shape of a coverage-gate
failure, not a test failure. `bunfig.toml` sets
`coverageThreshold = { lines = 0.8, functions = 0.8 }`.

### The root cause

Bun 1.4.3 enforces that threshold **per file**, not on the aggregate, and it
exits 1 **silently** when a covered file is below it. Both facts were
reproduced locally, outside the repository:

| Probe                                             | Aggregate        | Per file | Exit |
| ------------------------------------------------- | ---------------- | -------- | ---- |
| one file, one of two functions called             | 50.00% functions | 50.00%   | 1    |
| `a.ts` 79.00% functions, `b.ts` 100.00% functions | 89.50% functions | 79.00%   | 1    |

The second probe is the decisive one: the aggregate is comfortably above 80%
and the run still fails, because one file is below it.

### Reconciled with the prior W2 coverage artifact

The W2 lane is the packaged-selector lane, #1507 at `ae5316694b4dc5c62664a3a5a46244e71af09b0b`
(merged as `bd817698cbecbae02e0d210752befb60589ab760`). Its validation run is
`39347056288` and its coverage artifact is `coverage-unit-39347056288`
(artifact `12232081081`, digest
`sha256:9140dab4a08b60f5d61c211b58c41ea43d3f265a05f53f7b3307d9dfc492cadb`).
#1509's is `coverage-unit-39355828916` (artifact `12235651265`, digest
`sha256:573dd5e03332ea5ee2f31bb1865cf20c427c389693fa71359708842f25671b2a`).

Parsed from the two artifacts' `lcov.info`:

| File                                      | W2 (#1507)      | #1509           |
| ----------------------------------------- | --------------- | --------------- |
| files in the covered set                  | 132             | 134             |
| aggregate lines / functions               | 96.91% / 96.79% | 96.70% / 96.68% |
| **lowest file (min of line%, function%)** | **80.00%**      | **0.00%**       |
| files below the 80% per-file gate         | 0               | 1               |

The two files #1509 adds to the covered set are `scripts/test-dev-runtime-packaged.mjs`
(80.00% functions, 81.88% lines — exactly at the gate, and passing, as
`packages/db/src/schema/conventions.ts` also does at exactly 80.00% in W2) and
`scripts/dev-runtime-lane-report.mjs` (**0.00% functions, 14.81% lines**).

`scripts/dev-runtime-lane-report.mjs` enters the covered set because
`scripts/test-dev-runtime-packaged.mjs` imports it, and the new test injects
the summary writer, so the module itself was never executed by any test. That
is the whole defect: one uncovered module, imported by a new test, below an
unchanged per-file gate.

### The repair, and who owns it

The repair is already written and committed by the branch's owner, in the
owner's own worktree, and is **not yet pushed**:

```
c3334d1e515e957d886cfffb833c3eec1e63f0f3  (local, unpushed)
test(packaged): cover the dev-runtime lane report writer directly
```

It adds `scripts/dev-runtime-lane-report.test.ts`, which runs the real writer
against a disposable lane directory under the git-ignored `artifacts/` tree and
asserts the summary file, its contents, the breadcrumb, the stamped copy, the
overwrite behaviour, the lane-family directory, the empty-details default, the
non-negative duration and the created directory.

This lane verified that repair rather than writing a second one:

| Measurement                                       | #1509's head  | with `c3334d1e5`    |
| ------------------------------------------------- | ------------- | ------------------- |
| `scripts/dev-runtime-lane-report.mjs` lines       | 14.81% (4/27) | **100.00% (28/28)** |
| `scripts/dev-runtime-lane-report.mjs` functions   | 0.00% (0/1)   | **100.00% (2/2)**   |
| `scripts/test-dev-runtime-packaged.mjs` functions | 80.00% (4/5)  | 80.00% (4/5)        |
| files below the per-file gate                     | 1             | 0                   |

Command: `bun run test:unit` on the pull-request head with the owner's commit
applied, macOS arm64, Bun 1.4.3, Node 24.21.0, on 2026-10-20. The run's own
twelve failures are this machine's environment, not the change: they need a
shallow `git` clone, `psql`, `cf-wrangler` and a real `wrangler` binary, and
the same head reported **1916 pass, 0 fail** in CI. The only file still below
the gate after the repair is `packages/db/tests/fixtures/lead-production-factory-preflight.mjs`
at 50.83% lines, and it is below the gate only because those twelve tests
failed here; in CI it is covered.

The owner of that branch is active — the same worker committed on the Control
Plane and Railway lanes at 2026-10-20T07:28:01Z — so the commit was left
where its owner put it. It is not pushed from this lane, the branch is not
taken over, and no second repair was written.

## CP #1048 — the conflicting patch, preserved and mapped

The exact patch is `e635101384587b6d9e66dd6d1dbfb0eec8666883` in
`adea-ai/control-plane`, on `feat/profile-recovery-rollback-1025`. It is a
**draft** pull request, 100 files, +19,363 / −1,507, and its merge state is
`dirty`: it does not merge into the current default branch.

Its base is `8d11aa7c850e755bdd5b1a223cc6e03e0e250e80`
(`chore(main): release 1.103.1 (#1181)`, 2026-10-17). The current default
branch head is `f4f17194e04bcf8af65e8b5ff7aed7926b51ca88`
(`chore(main): release 1.105.3 (#1203)`).

### The conflict map

`git merge-tree --write-tree` between the patch and the current default branch
head reports **four conflicted files**, and every one of them is a Pi path:

| Conflicted file                                       | Conflict | Pi path |
| ----------------------------------------------------- | -------- | ------- |
| `apps/control-api/src/pi-durable/node-composition.ts` | content  | yes     |
| `docs/pi-durable-runtime.md`                          | content  | yes     |
| `tests/fixtures/pi-lead-restart/composition.mjs`      | add/add  | yes     |
| `tests/profile-recovery-pi-lead-restart.test.mjs`     | add/add  | yes     |

The Pi runtime paths are lane C's. This lane does not resolve them, does not
edit them, and does not take the Pi edits the patch carries. The patch is
preserved exactly as its owner left it.

The overlap with the merged Control Plane pull requests is 15 files, and the
same 15 for both:

```
apps/control-api/src/models/production-model-composition.ts
apps/control-api/src/pi-durable/lead-fence-live-harness.mjs
apps/control-api/src/pi-durable/node-composition.ts
apps/control-api/src/pi-durable/pi-durable-lead.service.ts
apps/hosted-control-plane/package.json
docs/pi-durable-runtime.md
scripts/integration-shards.mjs
scripts/run-bun-test-group.mjs
tests/fixtures/completed-managed-pi-client.mjs
tests/fixtures/pi-lead-restart/composition.mjs
tests/fixtures/pi-lead-restart/host.mjs
tests/fixtures/self-hosted-simple-sigkill.mjs
tests/integration-shards.test.mjs
tests/profile-recovery-pi-lead-restart.test.mjs
tests/repository.test.mjs
```

#1200 (merged `20ff342b707eea21486dcf4e0cb719a5b1d9c618`, 2026-10-20T03:51:25Z)
and #1202 (merged `79a31ddd04b58c3a15dfb0022340c9ddf05cfb6b`, 2026-10-20T06:28:02Z)
both landed changes in this region, which is why the patch does not merge
cleanly.

### The CI integration verdict

The patch's **non-Pi** files are its CI wiring, and they are exactly the five
files this lane owns in that repository:

```
scripts/integration-shards.mjs
scripts/run-bun-test-group.mjs
scripts/run-integration-tests.mjs
tests/integration-shards.test.mjs
tests/repository.test.mjs
```

`git merge-tree` reports all of them as **auto-merging, with no conflict**:
the CI half of the patch integrates with the current default branch as it
stands. The patch also adds `check:digest-writers` to the repository's lint
chain and registers `tests/digest-writer-guard.test.mjs` in the Bun test-group
registry; both are CI paths, and both merge cleanly.

So the integration split is clean: the CI paths integrate, and every remaining
conflict is a Pi path that belongs to lane C. Nothing in this lane's scope
blocks the patch, and nothing in this lane's scope may resolve it.

### Its logs

The patch's head has **no validation result**. Its 23 check runs are all from
2026-10-17T23:40Z, the last synchronisation, and every runner-heavy check is
`skipped` because the pull request is a draft: `Validation / Gate`, `Mode`,
`Core`, `Containers`, `Hosted Compose`, `Production containers`,
`PostgreSQL qualification`, `Integration and recovery`, `Native Pi`,
`Contracts`, `M10 Operability / Gate`, `Foundation Acceptance / Gate`,
`M9 Production Readiness / Gate`, `production-build` and `Core hardening`.
The only successes are `Review Policy / Gate` and `Draft PR / Create`.

The failure map for CP #1048 is therefore: no CI result exists for this head,
the merge state is `dirty` on four Pi paths, and the last recorded review
notes are the owner comments of 2026-10-10, 2026-10-14 and 2026-10-16.

## #1486, #1512 and #1513 — the merged heads

- **#1486** qualifies the generated macOS bundle's `adea` URL scheme and its
  recorded build target, and adds `apps/desktop/tests/packaged-scheme-target.test.ts`.
  Its evidence is `docs/evidence/desktop-packaged-scheme-target-2026-10-19.md`.
  It is merged, and its head is inside the candidate below.
- **#1512** adds the "Proposed rollback plan for root review" section to
  `docs/guides/railway-cutover-checklist.md`. Its merge commit
  `333b948d4c5fba1f88d98d764c075b790be6ee22` is the current `origin/main`.
- **#1513** corrects the stale child-operation claim in the 1173 README. It is
  merged as `2ca042b9cf6ecc7e983331827f0721cf0ac1a2ee`.

## Local-only failures observed, and where they belong

The local validation of this lane ran on macOS arm64, where the machine is
slower and some tools are absent. Three failures appear locally and none of
them is reproduced by CI, which reported 0 failures on the same code. They are
recorded here so each is routed to its owner rather than absorbed here.

| Failure                                                                                                                                                                                                                                                | Where                                                                                                                                | Owner                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `browser video relay reassembly > bounds one incomplete frame and discards it on timeout or close` timed out at the 5 s default under parallel load; it passes in isolation in 1.15 s                                                                  | `apps/web/test/browser-video-reassembly.test.ts`                                                                                     | the web lane                                                                               |
| `main, runVp and exit codes > runVp returns the exit code of vp when it runs without a process group` and its signal sibling, both at the 5 s default                                                                                                  | `scripts/vp-local-run.test.ts`                                                                                                       | the cache/tooling lane, whose branch `fix/vp-local-cache-lock-release-race` owns that file |
| four `github remote provider > update branch …` cases, `local git provider > a checkpoint prune …` and `attachment transaction and recovery hardening > record quota counts …`, all at the 5 s default; the desktop suite takes 43 s for 26 tests here | `apps/desktop/tests/dev-runtime-github-provider.test.ts`, `dev-runtime-git-provider.test.ts`, `dev-runtime-chat-attachments.test.ts` | the desktop lane                                                                           |
| the shallow-clone, `psql`, `cf-wrangler` and archive-provenance cases                                                                                                                                                                                  | the lead-production-factory suites                                                                                                   | the database lane; they need a real `git`, `psql` and `wrangler`                           |

None of the desktop-suite failures can come from this change: `apps/desktop/bunfig.toml`
preloads `tests/fixtures/child-process-guard.ts`, not the test-target guard,
and no file under `apps/desktop` is touched here. The suites that do preload
the guard — `packages/db`, `packages/auth` and `apps/web` — passed in full.

The one change made for them is in this lane's own file: the Playwright guard
case in `scripts/test-target-guard.test.ts` starts a Node process per scenario
and loads the Playwright config, so it was given an explicit 30 s ceiling. The
ceiling was raised; no assertion was weakened.

## The release candidate, for the lane that owns readiness

No release was run, published, deployed or marked ready here. This is the
candidate and its provenance, handed over rather than acted on.

**Candidate:** `adea-ai/adea` `origin/main` =
`333b948d4c5fba1f88d98d764c075b790be6ee22` (2026-10-20T06:33:57Z).

**Provenance.** It is the squash of #1512, whose reviewed head was
`7a3c423928a8c9d415b3cba0ca471c3d0158f7a4`. The check runs reported on it are
`success` for `Validate release`, `Desktop / macOS ARM64`, `Verify desktop
assets`, `Cut the dev pre-release` and `Cloudflare Production / adea-web /
Cloudflare Deploy / production`, and `skipped` for `Release`, `Publish release
notes`, `Validation` and `Mode` (the release-Please version pull request's own
flow). This is a check-run report: it does not show what is live, and it is
not a readiness decision.

**Bundle scheme and target.** #1486's merged qualification covers the scheme
and the build target of the generated bundle, and it is inside this candidate.
The qualification is a read of the generated bundle's `Contents/Info.plist` and
of the client's `adea-desktop-target.json`; a plain local build records
`mode: local` and `http://localhost:3000`, which
`apps/desktop/scripts/verify-release-target.mjs` rejects, so only a
release-mode client is a release-shaped artifact.

**Installation prerequisites, still open.** The acceptance runbook
(`docs/guides/packaged-desktop-acceptance-runbook.md`) records A6 and A11 as
`PENDING` (they need a locally built bundle), A7 and A9 as `BLOCKED` (native
credential access, or a cleared machine for a real install), and A8 and A10 as
`MISSING LANE` (no lane exists yet). The stable-build checklist
(`docs/evidence/stable-build-fresh-install-checklist.md`) records the release
gaps: the quarantined DMG install, notarization and Apple signing, real macOS
Keychain behaviour, the CEF profile path that ignores `HOME`, and the
release-lane claims in `docs/releasing.md` against the current workflow.

**Recovery.** Railway backup/restore or a forward fix. No Neon fallback, no
compatibility path and no rollback path is proposed here, and none is
available in the CI surface after
[the CI removal](ci-neon-removal-2026-10-20.md).

**Not decided here.** The decision owner, the readiness thresholds, the
signing authority and the deploy are root's. This record hands over the
candidate and its evidence; it authorizes nothing.
