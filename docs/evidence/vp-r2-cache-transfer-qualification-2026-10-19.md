# Cross-machine and cross-platform transfer qualification for the shared task cache

Repository `adea-ai/adea`. Qualification base
`2498a8b7c76828ab83d5f19a582e178cac1abc65`
(`fix(build): repair the shared R2 task-cache transport contract`), the exact
head of pull request **#1488** after its review repair. Qualification branch
`codex/r2-cross-platform-transfer-qualification-20261019`.

This receipt records what was qualified about a task-cache entry travelling from
one machine to another through the implemented transport, and what was **not**
claimed.

## 1. The predecessors and the state they left

| Predecessor                                   | Result                                                                |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `20261019-go-adea-r2-task-cache-transport-01` | finished: the transport contract and the export/import boundary proof |
| `20261019-adea1488-review-repair-01`          | finished: the repairs of review `5576644801`                          |

Pull request **#1488** after the repair:

|        |                                                      |
| ------ | ---------------------------------------------------- |
| branch | `codex/r2-task-cache-transport-w4-20261019`          |
| base   | `main` at `79790737d427a4b7902e733dcfdef3306786370b` |
| head   | `2498a8b7c76828ab83d5f19a582e178cac1abc65`           |
| state  | open, draft, auto-merge off                          |

That head carries the supported transport implementation, so it is the
qualification's starting base. The qualification was done in its own worktree
and branch, cut from that exact head.

Ownership was rechecked before the work: the only pull request and branch that
touch this scope are #1488 and its branch; no other branch or pull request
carries a cross-machine transfer qualification, and the open issues found on
the topic (`#1383`, `#839`) are unrelated.

## 2. The blocker that is preserved

The pinned Vite+ client (`vite-plus@1.3.0`) still has **no export and no
import** for its task cache. `vp cache` has one subcommand, `clean`:

```console
$ vp cache --help
Usage: vp cache <COMMAND>

Manage the task cache.

Commands:
  clean  Clean up all the cache
```

The qualification asserts that against the pinned client of the checkout
(`the pinned client still has no export and no import`), so the blocker cannot
be forgotten quietly. Nothing here changes it: the task-cache SQLite database
and its output archives are still the client's own private format, they are
still never shipped by the transport, and this receipt makes no portability claim
about them.

What is qualified is the transport's own envelope and the client's own
remote-cache entries, which are the only bytes the transport carries.

## 3. What a machine is

A machine is a **trust domain**: a namespace (the repository or tenant), the
pinned client version and the pinned toolchain identity. The toolchain identity
is what carries the platform. In this repository the toolchain id has the shape
`scripts/orch-toolchain.mjs` computes:

```text
<platform>-<arch>.<libc>.node<version>-<sha>.bun<version>-<sha>
```

and it holds a version and a hash of each binary, the platform and the libc,
but **never a path**: the same bytes at another path (another checkout, another
runner) keep their entries.

The qualification's boundaries follow from that:

| Boundary                    | Two machines                                                | Same domain? | The entry                                                                                           |
| --------------------------- | ----------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| cross-machine, same context | two checkouts of one repository, same platform and runtimes | yes          | transferred and replayed, byte for byte                                                             |
| cross-platform              | the same repository on another platform                     | no           | refused: the target cannot name the object, and the envelope refuses it as a compatibility mismatch |
| cross-client                | another pinned client version                               | no           | refused as a compatibility mismatch                                                                 |
| cross-namespace             | another repository sharing one store                        | no           | refused as a trust-domain mismatch                                                                  |

So the qualified result is precise: **the transport carries an entry between
machines of one trust domain, and it refuses to carry one across a platform, a
client version or a namespace.** It does not make a build portable across
platforms, and it does not claim to.

## 4. What was qualified, and how

The qualification is offline and synthetic. It uses the implemented transport
against an injected in-memory store, with synthetic entries: an archive that
holds every byte value, an archive that holds a multipart boundary as plain
bytes, and an archive of half a megabyte. No storage service, no credential, no
public endpoint and no deployment is involved.

New files, all of them new and all of them offline:

| File                                                             | What it is                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `scripts/vp-r2-cache-transfer.mjs`                               | the qualification harness: machine profiles, the transfer identity and the transfer report |
| `scripts/vp-r2-cache-transfer-fixtures.mjs`                      | the synthetic machines and entries                                                         |
| `scripts/vp-r2-cache-transfer.test.ts`                           | the qualification tests                                                                    |
| `docs/evidence/vp-r2-cache-transfer-qualification-2026-10-19.md` | this receipt                                                                               |

### 4.1 The transfer identity

The **transfer identity** of an envelope is the digest of its canonical bytes
with the recorded creation time blanked. It depends only on the entry bytes and
the trust domain, so it is the same on every machine of that domain. It is what
shows that the envelope encoding carries nothing of the machine that wrote it:
no path, no locale, and no clock beyond the creation time the envelope records.
Two envelopes of the same entry written by two different checkouts differ in
exactly one byte range - the creation time - and have the same identity.

### 4.2 The compatibility boundaries

The whole matrix of the fixture machines is qualified, every ordered pair on a
**fresh store** (a pair must not see what another pair wrote, or the boundary
would not be measured):

```text
25 pairs: 5 machines x 5 machines
same domain      -> replayable, refusedWith = none
other domain     -> refusedWith = "no entry was stored for that key"
envelope handed  -> "the envelope was written by another client or toolchain"
                   or "the entry belongs to another trust domain"
```

### 4.3 Integrity, path and size across the transfer

- an archive that holds every byte value arrives whole, and so does one that
  holds a multipart boundary as plain bytes, and so does a half-megabyte one;
- an archive that was changed under the transport is refused by its digest on
  the target (`the stored envelope failed its integrity checks`);
- an envelope of an unknown version is refused (`the stored envelope was
refused`);
- an entry that is larger than the bound is refused by the source and nothing is
  published;
- the object keys of a transferred entry carry the shared domain's digests and
  no path of either machine.

### 4.4 Atomic staging and the safe fallback across the transfer

- a transfer that fails in the middle publishes nothing and leaves no staging
  object behind;
- a store that never answers ends the transfer with a timeout fallback rather
  than an exception, and the target keeps its local cache;
- every refusal is a report, never a throw.

### 4.5 Nothing was activated

The qualification asserts that **nothing in the repository turns the transport
on**: neither `package.json` nor any workflow under `.github/workflows` names
`ADEA_VP_R2_CACHE_ENABLED` or `VP_REMOTE_CACHE`. The transport stays off unless
it is turned on explicitly, and no workflow, script or task calls it.

## 5. What was run

| Command                                                                                                                      | Result                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test scripts/vp-r2-cache*.test.ts`                                                                                      | **100 pass, 0 fail**, 395 assertions (the transport, the codec, the pinned-client replay and this qualification)                                                |
| `bun run format:check` (whole repository, pinned `oxfmt`)                                                                    | all matched files use the correct format                                                                                                                        |
| `bun run lint` (pinned `vp run orch:lint` and `oxlint --deny-warnings`, the repository's own configuration, no rule removed) | 0 warnings, 0 errors                                                                                                                                            |
| `bun run typecheck` (pinned `vp run orch:typecheck`)                                                                         | 33/33 tasks successful, "No type errors in 318 files"                                                                                                           |
| `vp run orch:test` (the repository's unit task lane)                                                                         | **1734 tests across 135 files, 0 fail**, 32/32 tasks successful - the same numbers as the qualification base and as `f9d5b1577`                                 |
| `bun test scripts/vp-r2-cache*.test.ts --coverage`                                                                           | aggregate **86.33% functions, 89.61% lines** (the goal is 80%); `scripts/vp-r2-cache-transfer.mjs` and `scripts/vp-r2-cache-transfer-fixtures.mjs` at 100%/100% |
| `bun run test:coverage`                                                                                                      | **crashes** in this environment, at the base commit and at the qualification base as well - see below                                                           |

### The coverage lane crashes here, before and after this change

`bun run test:coverage` ends in a **Bun 1.4.2 panic** in this environment:

```text
panic: range end index 1084 out of range for slice of length 1023
oh no: Bun has crashed. This indicates a bug in Bun, not your code.
error: script "test:coverage" was terminated by signal SIGABRT (Abort)
```

The same command at the base commit `f9d5b1577`, at the qualification base
`2498a8b7` and at this qualification head, each in a separate worktree with its
own `bun install --frozen-lockfile`, ends the same way at the same point: after
about 143 seconds, with the same docker registry rate limits in front of it
(`public.ecr.aws` and `docker.io` answer `toomanyrequests` for the postgres image
the container tests pull). The index the panic reports varies with the set of
files in the run (`1077` at `f9d5b1577`, `1084` at `2498a8b7`, `1077` here), so
it is the crash and not the index that is the constant. The lane does not
complete in this environment before or after this change; what completes is the
scripts lane, which contains the new files, and the unit task lane, which is
identical at every commit.

The coverage of the qualification's own files, from the scripts lane:

| File                                        | % Funcs | % Lines |
| ------------------------------------------- | ------: | ------: |
| `scripts/vp-r2-cache-transfer.mjs`          |   100.0 |   100.0 |
| `scripts/vp-r2-cache-transfer-fixtures.mjs` |   100.0 |   100.0 |

## 6. What is not claimed

- **No portability claim about the client's task cache.** The pinned client has
  no export and no import, its `node_modules/.vite/task-cache` is its own
  private format, and the transport does not ship it. What the transport carries
  is the client's own remote-cache entries and their output archive, and that
  is what this qualification measured.
- **No claim that a build is portable across platforms.** The qualification
  shows the opposite, and that is the point: a different platform is a
  different toolchain identity, so the entry is refused rather than replayed.
- **No live R2, no storage request, no credential, no public-read protocol, no
  deployment, no workflow edit and no paid service.** The whole qualification
  runs against an in-memory store over loopback.
- **No operational completion is claimed.** Nothing has run against a live
  store, and the transport stays off unless it is turned on explicitly.
- **The qualification is not a certification of the transport.** It measures the
  implemented contract against synthetic entries. The transport itself is still
  under review in #1488.
