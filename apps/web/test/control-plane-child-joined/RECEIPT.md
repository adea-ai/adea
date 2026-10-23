# Lead-to-child journey receipt (#1173)

Recorded local runs of `bun run test:integration:control-plane-journey`. They are not CI results
and the lane is not wired into CI (see Prerequisites).

| Run | Adea head                                                | Result                                                                                                                                                 |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `ab3e828a93e80a63ea04ea21af62801815fcb262`               | 26 pass, 0 fail, 254 expects, 177.5 s                                                                                                                  |
| 2   | `40bede118d5328655a49f7e9e07bfdd598a7a003`               | 26 pass, 0 fail, 254 expects, 175.5 s (exact PR head, main `f0e98ce` merged in)                                                                        |
| 3   | `1db1296888c89f16fb8fc6a8056a9f049bbe3689`               | 26 pass, 0 fail, 254 expects, 179.2 s (main `0b05aee` / #1419 merged in, plus the `admittedAt` regression test)                                        |
| 4   | `52548ed07a57de01257d5a98a094cd5ae326af8f`               | 27 pass, 0 fail, 260 expects, 205.4 s (main after #1500, CP `69e6e746`; see the run 4 paragraph below)                                                 |
| 5   | `043425c5aa8d619c086b19bcf71f18e17ab78e6f` + this branch | **blocked: 0 pass, 12 fail** — stopped at the package-identity path assertion before any journey test ran (CP `bda8b852`; see the run 5 section below) |

Run 4 was taken on a clean checkout of `52548ed0`, the main squash of #1500, before any edit to this
file. It is not like-for-like with runs 1 to 3. Main was repinned to CP `69e6e746` (CP release 1.104.0,
the `revision` in `source-journey.json`) by #1480 (`8152fa33`). Run 4 ran the five journey files, 27
tests: `journey.test.mjs` 6, `journey-recovery.test.mjs` 6, `journey-authority.test.mjs` 8,
`journey-identity.test.mjs` 6 and `journey-automatic-recovery.test.mjs` 1. Exit 0. Bun 1.4.3,
PostgreSQL 18.6 on a disposable cluster at 127.0.0.1:55432, started for this run. The node_modules
tree was not reinstalled for this run, and `journey-identity.test.mjs` passed against the installed
packages. The CP candidate manifest has head `69e6e746`, `dirty: false`, and sourceDigest
`sha256:179939366e85eb737df9bed25b1e41b5fe2a44da8b588422da43247e1fe402a5`. Run 4 `source-journey.json`
sha256 is `f9da35e6ff24fbcb2407c96190c1e31e90d9e1c8cb9925553e8af677821231ee`, and its `bun.lock` sha256
is `727242677529997d41d991d7f08621c6a293657c2e31255718ed815295e6d97a`. The run 1 to 3 values in the
table below differ for those files, as expected after the repin.

### Run 5 — blocked at the package-identity path assertion (no test ran)

Run 5 was taken on Adea main `043425c5aa8d619c086b19bcf71f18e17ab78e6f` (which includes #1580,
merged as `b9095bb4d3683341e4a2cb2a2d65dca72f9e1d31`, the bump to `@adea-ai/sdk` 1.20.1 and
`@adea-ai/contracts` 1.21.6; `@adea-ai/runtime-sdk` 1.17.1 came with it in `bun.lock`) plus the
changes in this branch, with `source-journey.json` repinned to CP release 1.106.6,
`bda8b8520f594bbf4404e3d239e518819f9e953f` (CP #1258, merged 2026-10-22T22:34:12Z). Provenance:
`@adea-ai/contracts` 1.21.6 was published from that release (npm 2026-10-22T22:36:05Z); `@adea-ai/sdk`
1.20.1 and `@adea-ai/runtime-sdk` 1.17.1 were published from CP release 1.106.5, `776688270`
(CP #1257, merged 2026-10-22T21:46:05Z; npm 2026-10-22T21:48:47Z and 21:48:56Z), and
`git diff 776688270 bda8b852 -- packages/control-sdk packages/runtime-sdk` is empty, so one revision
builds all three installed versions. Environment: Bun 1.4.4 (the `packageManager` pin), PostgreSQL
16.15 on a disposable cluster at `127.0.0.1:55432` with all 62 migrations applied and verified twice
by `bun run --cwd packages/db db:migrate`, and the Adea DB dependency packages built first. The CP
worktree is clean at the pin; the candidate manifest has head `bda8b852…`, `dirty: false`,
sourceDigest `sha256:24bcee1296c00995ba20f6ccd59dacae2c7a9364ad17b4fa1107e1ce2665c8f5`,
sourceFiles 2141, archive sha256 prefixes contracts `0350f31d`, runtime-sdk `5c5d87e3`, sdk
`6032cc03`.

Payload identity, proven separately with the gate's own rules (every archive file except
`package/package.json`, sha256 each, plus the load fields): contracts 77 of 77 files, runtime-sdk 77
of 77 and sdk 20 of 20 are byte-identical to the installed bytes, no differing file, versions
1.21.6 / 1.17.1 / 1.20.1, and each `bun.lock` sha512 equals the npm registry `dist.integrity` for
its version.

The qualification itself is **blocked and claims no passing test**. `bun run
test:integration:control-plane-journey` exited 1 with 0 pass, 12 fail across the five files: every
file stops in `beforeAll` at `installed-packages.mjs:85`, before the payload comparison and before
any journey test, with
`AssertionError: The input did not match the regular expression /node_modules\/\.bun\/@adea-ai\+[a-z-]+@[0-9.]+\/node_modules\//.
Input: '/Users/amf/.bun/install/cache/links/@adea-ai+contracts@1.21.6-1e02eb9fedacdc58/node_modules/@adea-ai/contracts'`.
Bun 1.4.4's isolated, global-store install resolves `realpathSync` into the cache links store with a
`-<hash>` suffix, and the negative-control copies inherit the same suffix
(`/private/var/…/journey-identity-*/node_modules/.bun/@adea-ai+contracts@1.21.6-<hash>/…`); under Bun
1.4.3 (run 4) the realpath stayed inside `node_modules/.bun/<name>@<version>/`. No verifier,
lockfile, dependency version, runtime source or install configuration was changed to get past it.
Run 5 therefore records the repin's provenance and the exact environmental gate blocker, not a
qualification: the lane must be re-run, and the new child-acceptance crash test executed, once the
install layout and the gate's path pattern agree.

Run 3 was taken on `1db1296`: `6e51924` plus the db regression test `c9c961a` and a merge of main
`0b05aee` (#1419, self-hosted connection UX). That merge added only web/e2e/workspace-ui files and
one spec page; it changed no journey file and not `bun.lock`. The same run also passed the db
integration file `lead-turn-historical.test.ts` (19 pass, including the new test).

Run 2 was taken on a clean worktree at head `40bede1`, which is `ab3e828` plus a merge of main
`f0e98ce` (#1422, readiness reasons). The merge changed no journey file and not `bun.lock`
(sha256 below, unchanged). Run 2 used the same CP revision, candidate manifest, `source-journey.json`
and database setup as run 1, with a freshly started disposable PostgreSQL. This file itself is
committed after run 2, so the PR head after that commit differs from `40bede1` by documentation only.

| Item                   | Value (runs 1 to 3; run 4 differs as stated above)                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Result                 | **26 pass, 0 fail**, 254 expects (runs above)                                                                                |
| Files                  | `journey.test.mjs` 6, `journey-recovery.test.mjs` 6, `journey-authority.test.mjs` 8, `journey-identity.test.mjs` 6           |
| CP revision under test | `0a453d83103a787bdcc6c38a6571de9188f7f559` (CP main, squash of CP #1134), tree `e05dc61fd86f5ca3f5176834148fa2885f4a5098`    |
| CP source digest       | `sha256:027e74f46f52abde673ff1dc238be5b5c26ef308cecbf7dc169b56796cddac89`                                                    |
| Installed packages     | `@adea-ai/sdk` 1.18.1 (20 files), `@adea-ai/contracts` 1.21.3 (77), `@adea-ai/runtime-sdk` 1.15.1 (77), from Adea `bun.lock` |
| Payload comparison     | Byte-identical to the packages the CP revision builds, every file; no allowed drift                                          |
| Candidate archives     | contracts `1fc4a186…`, runtime-sdk `233a7e50…`, sdk `21ec3b5a…` (sha256 prefixes, manifest `head` = CP revision)             |
| `bun.lock` sha256      | `709d7184720426c515e38a5712e01e25dbd03c507035b2529d6c3923bd0e4b8b`                                                           |
| `source-journey.json`  | sha256 `e36c742f2897800544f39ad7eda84d547806a0241276e86b6807eabfe4eb65a6`                                                    |
| Runtime                | Bun 1.4.2, Node 22.22.0, PostgreSQL 16 on 127.0.0.1:55432 (disposable database), Linux                                       |
| Providers and spending | Scripted local provider transport; no live provider, credential, deployment or release                                       |

## Prerequisites (all required; none is provided by CI)

1. `bun install --frozen-lockfile` at the Adea head, so `apps/web/node_modules/@adea-ai/*` are the
   lockfile versions above. A stale install fails the identity gate before any database is opened.
2. A clean, built checkout of `adea-ai/control-plane` at `0a453d83103a787bdcc6c38a6571de9188f7f559`
   for runs 1 to 3, at `69e6e7469d81557645937ba7f525077a53b51558` for run 4, or at
   `bda8b8520f594bbf4404e3d239e518819f9e953f` for run 5 (the current `source-journey.json` pin). Its
   candidate archives packed with
   `node scripts/pack-pi-durable-candidate.mjs <dir>` from that checkout
   (`PI_FACTORY_MANIFEST=<dir>/manifest.json`; `PI_FACTORY_BUN` the absolute Bun path).
3. A local, disposable PostgreSQL with the Adea schema (`DATABASE_URL`, here
   `127.0.0.1:55432`), and the Adea DB dependency packages built
   (`bun run --cwd packages/remote-content build`, then `types`, `auth` and `db`), otherwise
   `harness.mjs` fails to import `@adea-ai/db` before any suite runs.

```sh
ADEA_CONTROL_PLANE_SOURCE=<CP checkout at the source-journey.json pin> PI_FACTORY_BUN=<abs bun> \
PI_FACTORY_MANIFEST=<dir>/manifest.json DATABASE_URL=<local postgres> \
  bun run test:integration:control-plane-journey
```

## What this receipt does and does not establish

- It establishes the journey behavior recorded in `README.md` against that CP revision and the
  lockfile packages. `journey-identity.test.mjs` shows the identity gate refusing a changed byte
  (contracts and runtime-sdk), a missing file, a changed load field and a floating range.
- It does not establish a CP OS-process restart, revocation inside the publication transaction, a
  handoff target, a published CP release, a live provider, or any CI coverage. For runs 1 to 3, the
  CP revision is a merged source revision, not a release. Run 4 uses `69e6e746`, CP release 1.104.0
  per `source-journey.json`, but run 4 does not establish release or deployment qualification.
- Run 4 is author-reported local evidence. It is not hosted CI, and it does not complete #1173.
- Run 4 does not establish lead terminal accounting in the production composition. That composition
  exposes only child settlement, so lead terminal settlement runs only in the periodic pass.
- Run 5 establishes **no passing test at all**: it is a blocked run. Nothing in this lane is claimed
  green at the repinned revision, and the new child-acceptance crash test in
  `journey-recovery.test.mjs` has not executed anywhere.
