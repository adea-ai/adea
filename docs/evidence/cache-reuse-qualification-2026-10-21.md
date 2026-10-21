# Cache correctness and reuse qualification (adea-ai/adea#1565)

Repository `adea-ai/adea`, read and measured at `origin/main` `d3c24c1c1960ea04692eefae9b827de0dd9e0d0d`
("fix(deps): update dependency @adea-ai/ui to v0.146.0 (#1558)"), 2026-10-21 20:25:14 -0400. Branch
`feat/1565-cache-reuse-qualification`, one commit on top of that base. Toolchain: `bun 1.4.3`, `node 24.21.0`,
`darwin-arm64`, the repository's own pins.

## 1. What this document is, and what it deliberately does not repeat

The **cache inventory** — which consumers exist, which keys they use, which owner each one has — is not restated
here. It is held by the fleet's cache acceptance gap map (`plan-adea-r2-cache-acceptance-gap-map.md`, read at
`f8ede17f2`) and by the lane evidence `docs/evidence/vp-local-cache-lane-e-2026-10-20.md` (§4.5 and §4.7). This
document **relates** to those two: it names the boundaries it qualifies, the measurements it does not repeat, and
the properties that neither of them recorded.

The three boundaries are the ones the tracker already names: the **local** shared task cache
(`scripts/vp-local-run.mjs`), the **GitHub Actions** caches (`.github/workflows/vite-plus-proof.yml` and
`.github/workflows/task-cache-qualification.yml`), and the **R2** task-cache transport
(`scripts/vp-r2-cache*.mjs`, off by design). This qualification is **local and offline**: it exercises the local
boundary and the shared-cache behaviour of the wrapper, and it says nothing new about the hosted Actions caches or
about the R2 transport.

## 2. The properties this qualification adds

The tracker records that the local cache's contract is held by the wrapper's own tests and by two measurements
(§A of the map), and that the Actions cache is held by the hosted cold/warm pair (§B). What neither recorded is
the **correctness** side of the reuse, stated as executable properties:

| #   | Property                                                                                                                                                                                                                       | Where it is qualified                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The environment key separates every build-relevant identity: the lockfile, the build config, the pinned toolchain (Node, `vite-plus`), the platform and the build-relevant environment. An unrelated variable changes nothing. | `scripts/cache-reuse-qualification.test.ts` — "the environment key separates every build-relevant identity" (key level) and "a plan under a changed identity selects a different directory" (plan level) |
| 2   | **The directory decides only which entries are visible, never whether an entry is valid.** A source edit inside one dirty state must still miss, a second different edit must miss again, and the same content must hit again. | the same file — "cold then warm: the first run misses, the second hits, and a source edit misses again" (real client)                                                                                    |
| 3   | Two checkouts of one repository at one commit share the clean directory; a dirty checkout is isolated and does not disturb the shared entry.                                                                                   | the same file — "two checkouts of one repository at one commit share the clean directory; a dirty one does not" (real client)                                                                            |
| 4   | A cache that cannot be used is refused and the run **falls back** to the plain run instead of failing.                                                                                                                         | the same file — "a cache that cannot be used is refused and the run still succeeds" (real client)                                                                                                        |
| 5   | No credential-shaped value from the environment reaches the shared cache.                                                                                                                                                      | the same file — "no credential-shaped value from the environment reaches the shared cache" (real client)                                                                                                 |

Property 2 is the one the earlier receipts did not establish. The lane evidence §4.7 isolates a **tracked
modification** into a directory of its own, which shows _isolation_; it does not show what happens when two
different sources share one directory. The qualification now shows that the entry is keyed by the client's input
fingerprint: two different sources in the same dirty state are two misses, and the same source is a hit again.

## 3. The measurement, and that it is not a fixture

The runs are the repository's own: the pinned client (`vite-plus` 1.3.0, the repository's lockfile pin) and the
repository's own graph, in a disposable git worktree of this repository with the pinned dependencies borrowed from
this checkout. The hit and miss counts are parsed from the client's **own** `vp run` output, through the same
parser the hosted proof uses (`scripts/vite-plus-proof.mjs` → `parseVpOutput`, `matchesPattern`). No fake cache,
no synthetic client and no substituted key took part.

One real, small, portable task was used: `orch:types:build` (the `@adea-ai/types` workspace build, one cacheable
task). The full graph was deliberately not used: the qualification is about the cache's correctness, and the
15-task graph's behaviour is already recorded in the lane evidence.

The five real sequences, each a fresh disposable cache home and a fresh disposable checkout:

| Sequence               | Runs | Observed                                                                                                                                                                                           |
| ---------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold, then warm        | 2    | cold: `0/1` cache hit; warm: `1/1` cache hit                                                                                                                                                       |
| Source invalidation    | 3    | after a source edit: `0/1`; after a _different_ source edit in the same dirty state: `0/1`; the same content again: `1/1`                                                                          |
| Identity invalidation  | 5    | one more build-relevant variable at the same commit and a clean checkout: `0/1`; the original identity: `1/1`; a changed lockfile: `0/1`; a changed build config: `0/1`; the original again: `1/1` |
| Worktree isolation     | 4    | the second checkout at the same commit: `1/1` (the shared entry is reused); a dirty checkout: `0/1` in its own directory; the clean checkout again: `1/1` (the shared entry was untouched)         |
| Safe failure           | 2    | with a symlinked component on the cache path the shared cache is refused (`vp-local-run: … no shared cache`) and the run still succeeds, with no cache hit                                         |
| Credential non-leakage | 1    | with `BUN_INSTALL_TOKEN` and `NPM_CONFIG_AUTHSRC` set to a known value, that value appears nowhere under the cache home — not in a path, a file name or a file's bytes                             |

## 4. Exact checks

Every command below was run on this branch at the head named in §1, with the pinned toolchain.

| Command                                                                                                                                                                             | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test scripts/cache-reuse-qualification.test.ts scripts/vp-local-run.test.ts scripts/vite-plus-proof.test.ts scripts/no-neon-cache-scope.test.ts scripts/toolchain-pin.test.ts` | **121 pass, 0 fail, 1081 assertions across 5 files** (39.10 s)                                                                                                                                                                                                                                                                                                                                                                                                                |
| `bun test scripts/cache-reuse-qualification.test.ts` alone                                                                                                                          | **7 pass, 0 fail, 45 assertions** (23.02 s)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `bunx oxfmt --check scripts/cache-reuse-qualification.test.ts docs/evidence/cache-reuse-qualification-2026-10-21.md`                                                                | `All matched files use the correct format.`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `bunx oxlint --deny-warnings scripts/cache-reuse-qualification.test.ts`                                                                                                             | no findings                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `bun run typecheck` (`vp run orch:typecheck`)                                                                                                                                       | **fails in `apps/web` only, and not because of this change**: this checkout's installed `@adea-ai/ui` is 0.142.4 while the base pins 0.146.0 (the last commit on `main`), so `src/components/workspace-identity-mark.tsx` cannot resolve `@adea-ai/ui/components/composites/icon-picker`. The workspace typecheck tasks do not cover `scripts/`, and this change adds a `scripts/` test and a `docs/` document only. Clearing it needs a dependency install, and none was run |
| `bun node_modules/typescript6/lib/tsc.js --ignoreConfig --noEmit --strict … scripts/cache-reuse-qualification.test.ts`                                                              | two `TS7016` diagnostics, for the untyped `./vp-local-run.mjs` and `./vite-plus-proof.mjs` imports. The same check reports four `TS2345` diagnostics on the existing `scripts/vite-plus-proof.test.ts`, and no workspace typecheck covers `scripts/`, so the new file follows the scope's existing pattern rather than adding a gate                                                                                                                                          |

The seven qualification cases are conditional on the pinned client and the pinned toolchain being present, and
they are **skipped visibly** without them, exactly as the transfer qualification does. The two key-level cases
always run.

## 5. What this qualification does not claim

- **The hosted GitHub Actions caches are not re-qualified here.** The cold/warm pair for the current graph stays
  where it is, in the lane evidence §4.8; the Actions key's own invalidation is a property of the key, and the
  Actions scope's contract is the proof script's own test suite.
- **The path-embedding task is not repeated.** `apps/web build` embeds the absolute path of the checkout that
  built it, so it is keyed per checkout and is rebuilt under a second checkout; the lane evidence §4.7 measured
  exactly that (14 of 15 hits, the single miss being that task). The qualification above uses a portable task on
  purpose and therefore does not re-measure it.
- **The 10,500-run lock measurement is not repeated.** The lane evidence §2.6 measured it, and the file it used is
  byte-identical to the one in this base.
- **The R2 transport is not qualified here.** It is off by design, and a live store, a credential and a permission
  are root's decisions. No Cloudflare resource, bucket, endpoint or deployment was created or used.
- **No cache was purged, and no shared or hosted cache was deleted.** Every cache home in this qualification was
  disposable, created by the run and removed with it.
- **No credential was read, created or used**, and no secret store was inspected. The only credential-shaped
  values in this qualification are synthetic strings the test itself supplies, and the test proves they do not
  reach the cache.
- **No release or CI gate changed.** The two cache workflows are untouched, and the qualification adds a test file
  and this document only.
- **Nothing here qualifies a deployed, hosted or production cache**, and no timing, load or cutover claim is made.

## 6. The open gates this qualification leaves open

- The **native and human-acceptance gates** of the cache lane are untouched: the hosted proof still needs its own
  runner, the Actions caches still need a CI run at a new graph, and the R2 transport still needs root's decision
  about a live store.
- The **authentication, session and permission reads** stay cache-disabled and belong to the separate routing
  tracker (adea-ai/adea#1562), not to this issue.
- The **worktree consolidation** is a separate scope (adea-ai/adea#1566) and is not touched here; this
  qualification used disposable worktrees and removed them.

## 7. Handoff

- The qualification is one new test file and one new evidence document, on a branch one commit over the current
  `origin/main` `d3c24c1c1`.
- The inventory this document deliberately does not repeat is in the fleet's cache acceptance gap map and in
  `docs/evidence/vp-local-cache-lane-e-2026-10-20.md`; this document's §2 names exactly which property of each
  boundary it adds, and §3 shows the measurement that was not in either.
- The publication route is the open gate: see the operator handoff for the exact commands and the state of the
  pull request.
