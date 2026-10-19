# Cross-machine and cross-platform transfer qualification for the shared task cache

Repository `adea-ai/adea`. Qualification base
`42ac235ac90611f200c8b0d50b49da060a596e43`
(`fix(build): make the publication fence a protocol, not a deletion`), the exact
head of pull request **#1488** after its review repairs. Qualification branch
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

|        |                                             |
| ------ | ------------------------------------------- |
| branch | `codex/r2-task-cache-transport-w4-20261019` |
| base   | `main`, moved forward by the branch update  |
| head   | `42ac235ac90611f200c8b0d50b49da060a596e43`  |
| state  | open, draft, auto-merge off                 |

That head carries the supported transport implementation, so it is the
qualification's starting base. The qualification was done in its own worktree
and branch, cut from that exact head, and it was **resumed on the repaired head**
after each review: the qualification branch carries the repaired transport and
the qualification together, and the qualification was measured again against the
repaired contract.

The owner branch was updated by GitHub with a merge of `main` while the
qualification was in flight (`f61aa44c46f550a514f2ca3849dba435eb268ffc`, a
merge of `main` into the branch). It brought main's own commits and touched none
of this scope's files; the qualification was rebased onto it and re-measured.

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

Two qualifications need the pinned client of the checkout, and **without it they
are not established**: the client's `vp cache` surface is read to confirm that
it still has no export and no import, and the replay in the transport's own
pull request is what exercises the client against the transport. When the client
is not installed, those checks are **skipped visibly** - the run reports a
skip - and this receipt makes no claim for them. The rest of the qualification
is synthetic and holds either way.

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
the trust domain, so it is the same on every machine of that domain. Two
envelopes of the same entry written by two different checkouts differ in exactly
one byte range - the creation time - and have the same identity.

What that establishes is narrow, and it is worth being exact about it: **the
envelope encoding is deterministic**. The transport's own envelope carries no
path, no locale and no clock beyond the creation time it records.

It does **not** establish that the client's opaque key and value bytes are free
of checkout-sensitive content. Those bytes come from the client, they are
opaque here, and the qualification compares them rather than interpreting them.
A client that embedded a checkout path in its key or value would still produce
the same identity on two machines, because the path is inside the bytes the
identity digests. Whether the client does that is the client's business, and
this qualification makes no claim about it.

The identity is also derived from the **validated stored envelope**, never from
the expected input: the qualification reads the envelope back out of the store
and validates it under the domain that wrote it. An entry in the store that
carries the same key, task fingerprint key and archive but another value is
reported as a different entry, with the identity of what is stored.

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
  holds a multipart boundary as plain bytes, and so does a half-megabyte one.
  These are **direct storage tests**: they put the bytes in a store and take
  them out again, and they do **not** exercise the multipart parsing. The
  multipart grammar is qualified by the transport's own suite (the pull request
  that carries the contract), not here;
- an archive that was changed under the transport is refused by its digest on
  the target (`the stored envelope failed its integrity checks`);
- an envelope of an unknown version is refused (`the stored envelope was
refused`);
- an entry that is larger than the bound is refused by the source and nothing is
  published;
- the object keys of a transferred entry carry the shared domain's digests and
  no path of either machine.

### 4.4 The final read, the atomic staging and the safe fallback across the transfer

- the final read of the stored envelope is bounded by the bytes it may hold and
  by the deadline that is left, and it carries the caller's signal: a store that
  rejects the read or never answers ends the read with a refusal instead of
  ending the qualification with an exception or a hang;
- the report is built from the envelope the **target** read, not from the
  source's earlier view of the same object: the two may differ when the store
  changes between the two reads, and the booleans and the identity must
  describe what the target would replay. The source's own view is reported
  beside them, so a change between the reads is visible;
- the publication, the lookup, the archive read and the reads of the stored
  envelope share **one** operation, so the qualification has one deadline and
  one signal instead of a deadline each;
- a signal that was **already aborted** ends a read at once - the guard cannot
  wait for an event that has been sent - and the bytes a store returns are
  **measured** before anything is parsed, not taken on the store's word;
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

## 4.1 The repairs of the review of `9c2f1688`

| #   | The review asked for                                                           | What was done                                                                                                                                 | Where it is proved                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | a signal that is already aborted must not slip into a read that never answers  | the guard checks the controller before it registers its listener, because the abort event has already been sent                               | `the bounded reads of the qualification > a read that is given an aborted signal ends at once`                                                                             |
| 2   | the returned bytes must be measured before they are parsed                     | the length is checked against the bound in the qualification, not taken on the store's `maxBytes`                                             | `a store that returns more than the bound is refused before it is parsed`                                                                                                  |
| 3   | the remaining budget and the signal must reach the lookup and the archive read | the publication, the lookup, the archive read and the reads of the stored envelope share **one** operation, with its deadline and its signal  | `the whole qualification runs under one deadline`                                                                                                                          |
| 4   | the test discovery was wrong: a missing import and the wrong `skipIf` form     | `existsSync` is imported, the skip uses Bun's `test.skipIf(condition)(name, fn)` form, and both the present and the absent client are covered | `records whether the pinned-client qualification is established`, `the client discovery reports a checkout without the pinned client`, and the skipped export/import check |

## 4.2 The repair of the target-envelope finding

| The review asked for                                                                                                                                          | What was done                                                                                                                                                                                                          | Where it is proved                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a target lookup can return a valid envelope whose value differs between the source read and the final read, while `replayable` and `valueIdentical` stay true | the report is built from the envelope the **target** read: the byte comparison, `valueIdentical`, `entryIdentical` and the transfer identity all follow that snapshot, and the source's own view is reported beside it | `the final read of the stored envelope > a target envelope that differs from the source read is not replayable`: the store returns the original envelope for the source's read and another **valid** envelope - its digests match its own content - for the target's, and the report says `valueIdentical: false`, `entryIdentical: false`, `replayable: false` and the identity of the envelope the target read |

## 5. What was run

| Command                                                                                                                      | Result                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test scripts/vp-r2-cache*.test.ts`                                                                                      | **121 pass, 0 fail**, 466 assertions (the transport, the codec, the pinned-client replay and this qualification)                                                              |
| `bun run format:check` (whole repository, pinned `oxfmt`)                                                                    | all matched files use the correct format                                                                                                                                      |
| `bun run lint` (pinned `vp run orch:lint` and `oxlint --deny-warnings`, the repository's own configuration, no rule removed) | 0 warnings, 0 errors                                                                                                                                                          |
| `bun run typecheck` (pinned `vp run orch:typecheck`)                                                                         | 33/33 tasks successful, "No type errors in 318 files"                                                                                                                         |
| `vp run orch:test`                                                                                                           | **32/32 tasks successful**, 1778 tests across 138 files                                                                                                                       |
| `bun test scripts/vp-r2-cache*.test.ts --coverage`                                                                           | aggregate 85.27% functions, 87.95% lines (the goal is 80%); `scripts/vp-r2-cache-transfer.mjs` at 92.86%/100.00% and `scripts/vp-r2-cache-transfer-fixtures.mjs` at 100%/100% |
| `bun run test:coverage`                                                                                                      | **crashes** in this environment, at the base commit and at the qualification base as well - see below                                                                         |

### The coverage lane crashes here, before and after this change

`bun run test:coverage` ends in a **Bun 1.4.2 panic** in this environment:

```text
panic: range end index 1084 out of range for slice of length 1023
oh no: Bun has crashed. This indicates a bug in Bun, not your code.
error: script "test:coverage" was terminated by signal SIGABRT (Abort)
```

The same command at the base commit `f9d5b1577`, at the qualification bases
`2498a8b7`, `6686d3b6` and `42ac235a`, and at this qualification head, each in a separate
worktree with its own `bun install --frozen-lockfile`, ends the same way at the
same point: after about 143 seconds, with the same docker registry rate limits
in front of it (`public.ecr.aws` and `docker.io` answer `toomanyrequests` for the
postgres image the container tests pull). The index the panic reports varies
with the set of files in the run (`1077` at `f9d5b1577`, `1084` at `2498a8b7`,
`1077` at this head), so it is the crash and not the index that is the constant. The crash is a Bun
crash rather than a test failure, and it is **not** the pinned checks above:
those ran under the repository-pinned Bun 1.4.3 and the pinned Node 24.21.0 and
passed. The crash is recorded under both runtimes that were tried, the system
Bun 1.4.2 and the pinned Bun 1.4.3. The lane does not
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
