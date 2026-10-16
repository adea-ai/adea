# Lead-to-child journey receipt (#1173)

Recorded local runs of `bun run test:integration:control-plane-journey`. They are not CI results
and the lane is not wired into CI (see Prerequisites).

| Run | Adea head                                  | Result                                                                                                          |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 1   | `ab3e828a93e80a63ea04ea21af62801815fcb262` | 26 pass, 0 fail, 254 expects, 177.5 s                                                                           |
| 2   | `40bede118d5328655a49f7e9e07bfdd598a7a003` | 26 pass, 0 fail, 254 expects, 175.5 s (exact PR head, main `f0e98ce` merged in)                                 |
| 3   | `1db1296888c89f16fb8fc6a8056a9f049bbe3689` | 26 pass, 0 fail, 254 expects, 179.2 s (main `0b05aee` / #1419 merged in, plus the `admittedAt` regression test) |

Run 3 was taken on `1db1296`: `6e51924` plus the db regression test `c9c961a` and a merge of main
`0b05aee` (#1419, self-hosted connection UX). That merge added only web/e2e/workspace-ui files and
one spec page; it changed no journey file and not `bun.lock`. The same run also passed the db
integration file `lead-turn-historical.test.ts` (19 pass, including the new test).

Run 2 was taken on a clean worktree at head `40bede1`, which is `ab3e828` plus a merge of main
`f0e98ce` (#1422, readiness reasons). The merge changed no journey file and not `bun.lock`
(sha256 below, unchanged). Run 2 used the same CP revision, candidate manifest, `source-journey.json`
and database setup as run 1, with a freshly started disposable PostgreSQL. This file itself is
committed after run 2, so the PR head after that commit differs from `40bede1` by documentation only.

| Item                   | Value (identical for all runs)                                                                                               |
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
   (`ADEA_CONTROL_PLANE_SOURCE`), and its candidate archives packed with
   `node scripts/pack-pi-durable-candidate.mjs <dir>` from that checkout
   (`PI_FACTORY_MANIFEST=<dir>/manifest.json`; `PI_FACTORY_BUN` the absolute Bun path).
3. A local, disposable PostgreSQL with the Adea schema (`DATABASE_URL`, here
   `127.0.0.1:55432`).

```sh
ADEA_CONTROL_PLANE_SOURCE=<CP checkout at 0a453d8> PI_FACTORY_BUN=<abs bun> \
PI_FACTORY_MANIFEST=<dir>/manifest.json DATABASE_URL=<local postgres> \
  bun run test:integration:control-plane-journey
```

## What this receipt does and does not establish

- It establishes the journey behavior recorded in `README.md` against that CP revision and the
  lockfile packages. `journey-identity.test.mjs` shows the identity gate refusing a changed byte
  (contracts and runtime-sdk), a missing file, a changed load field and a floating range.
- It does not establish a CP OS-process restart, revocation inside the publication transaction, a
  handoff target, a published CP release, a live provider, or any CI coverage. The CP revision is a
  merged source revision, not a release.
