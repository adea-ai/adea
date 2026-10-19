# Shared R2 task-cache transport: export/import boundary, contract and repairs

Repository `adea-ai/adea`. Base `f9d5b1577ba0b0d8f932f9732b7f3867053e1c83`
(`chore(main): release 0.98.0 (#1484)`), the tip of `origin/main` when this work
started. Branch `codex/r2-task-cache-transport-w4-20261019`.

This receipt records what was proved about the pinned Vite+ client before any
transport was designed, what the transport contract in `scripts/vp-r2-cache*.mjs`
is, the repairs that review `5576644801` asked for, and what is **not** claimed.

## Scope

| File                                 | What it is                                                     |
| ------------------------------------ | -------------------------------------------------------------- |
| `scripts/vp-r2-cache.mjs`            | the transport contract                                         |
| `scripts/vp-r2-cache.cbor.mjs`       | the strict CBOR subset the client's remote cache protocol uses |
| `scripts/vp-r2-cache-fixtures.mjs`   | synthetic fixtures and an in-memory object store               |
| `scripts/vp-r2-cache.test.ts`        | the offline proof                                              |
| `scripts/vp-r2-cache.cbor.test.ts`   | the codec proof                                                |
| `scripts/vp-r2-cache-replay.mjs`     | the reproducible pinned-client replay harness                  |
| `scripts/vp-r2-cache-replay.test.ts` | the test that runs the replay                                  |

Nothing else in the repository changed. No workflow, no `package.json` script, no
`vite.config.ts`, no task graph and no existing script was touched.
`ORCH_CHECKOUT` (`scripts/orch-graph.mjs`) is unchanged, and the local shared
cache (`scripts/vp-local-run.mjs`) is unchanged: the transport is a separate,
opt-in contract that no current build path calls.

## 1. The export/import boundary of the pinned client

The pinned client is `vite-plus@1.3.0` (`package.json`), the runtime pinned by
`.github/code-foundry.yml` (`runtime_ref: v1.48.1`) and the tool the task graph
runs (`monorepo_tool: vite-plus`).

### 1.1 There is no export and no import

```console
$ bun ./node_modules/vite-plus/bin/vp cache --help
Usage: vp cache <COMMAND>

Manage the task cache.

Commands:
  clean  Clean up all the cache
```

`vp cache` has exactly one subcommand, `clean`. There is no `vp cache export`,
no `vp cache import`, and no other command in `vp --help` that reads, writes or
exports the task cache. `vp run --help` lists `--cache`, `--no-cache` and
`--log`, and nothing that moves a cache between machines.

### 1.2 What the task cache is on disk

A real cache was produced by running a task with the pinned client:

```text
node_modules/.vite/task-cache/v18/cache.db                 (SQLite)
node_modules/.vite/task-cache/v18/<uuid>.tar.zst           (one output archive per entry)
node_modules/.vite/task-cache/v18/last-summary.json
node_modules/.vite/task-cache/v18/db_open.lock
```

The database holds two tables and nothing else:

```sql
CREATE TABLE cache_entries (key BLOB PRIMARY KEY, value BLOB);
CREATE TABLE task_fingerprints (key BLOB PRIMARY KEY, value BLOB);
```

`cache_entries.key` is the spawn specification of the task (its command and the
tracked environment names); `cache_entries.value` is the fingerprint of the
inferred inputs and the name of the output archive; `task_fingerprints` maps a
task to its entry.

**This database is the client's private format and is not treated as portable
here.** It is not a documented interchange format, it changes with the client
(the directory is named for the schema version, `v18`), and its values name the
producer's own input paths. The transport in this change therefore never ships
the database. What it ships is the triple the client itself already exchanges
with a remote cache: the entry key, the task fingerprint key and the entry
value, with the output archive beside them as an opaque blob.

### 1.3 What the client does support, and the protocol it speaks

The client has a native remote cache. It is off unless an endpoint is
configured, and it is selected by `VP_REMOTE_CACHE` (`off`, `read`,
`read-write`) or `VP_REMOTE_CACHE_URL`, with `cache.remote.url` as the
configuration equivalent:

```text
If you don't pass this flag, `VP_REMOTE_CACHE` selects the mode. If neither is
set, the mode is `read` when an endpoint is configured, or `off` otherwise.
```

The wire protocol is not documented in the published package, so it was observed
against the pinned client itself, on loopback, against a throwaway local project
whose task printed one line and wrote one file. The client is the only party
that was contacted; no external service was reached.

```text
POST <base>/fetch   content-type: application/cbor
                    body: CBOR map { key: bytes, secondary_key: bytes }

200                 content-type: application/cbor
                    body: CBOR map { kind, key, secondary_key, value, blob_id }

POST <base>/store   content-type: multipart/form-data
                    part "metadata": application/cbor  -> { key, secondary_key, value }
                    part "blob":     application/octet-stream -> the output archive

GET  <base>/blob/<blob_id>   -> the archive bytes
```

The shape was found by reading the client's own error messages, which name the
field that is missing (`missing field 'kind'`, then `missing field 'blob_id'`)
and then the step that failed (`remote cache download failed` -> `HTTP status
404`). The `blob_id` is chosen by the server, not by the client: the client's
upload carries no such field.

Two properties of the protocol matter for the transport:

- the client's key is **stable across runs** for the same task and the same
  inputs (two consecutive runs produced byte-identical `key` and
  `secondary_key`), so an entry stored once is found again;
- the client's key names the **spawn specification**, so a task whose command
  carries a checkout identity (the `ORCH_CHECKOUT` fingerprint in
  `scripts/orch-graph.mjs`) simply has a different key on another checkout and
  misses there. The transport never rewrites a cached command or a cached
  value, so this stays true.

## 2. The transport contract

`scripts/vp-r2-cache.mjs` implements the server side of that protocol against an
**injected** object store. It has no provider, no credential, no endpoint and no
network call; the store is the caller's, and every method of it is bounded.

### 2.1 The two layers

The exported store operations (`publishEntry`, `lookupEntry`, `readBlob`) are the
**lower level**. They take an explicit trust domain and a store, they do no
authorization and no enable check, and they refuse to run without a domain.
They are for a caller that has already decided that this domain may use this
store.

`handleRemoteCache` is the **enabled and authenticated handler**: the only entry
point that serves a request from outside. It refuses to answer at all while the
transport is off, and it refuses every request that carries no authorization
decision bound to the domain.

`createTransport({ scope, store })` is the constructor contract that binds the
two: one transport serves one trust domain against one store.

### 2.2 The trust domain

Every entry belongs to a **trust domain**: a namespace (which repository or
tenant the entries belong to) and a compatibility context (the pinned client
version and the pinned toolchain identity). The domain is mixed into every
object key and recorded in every envelope:

```text
entries/<domain>/<sha256(key)>/<sha256(secondary_key)>/entry.json
blobs/<domain>/<sha256(archive)>
staging/<domain>/<generated uuid>
```

A store shared by two domains is therefore safe: the second domain cannot name
the first domain's objects, and an envelope written for another domain is
refused when it is read back. The compatibility context is checked as well, so
an entry written by another client version or another toolchain is refused: the
envelope version is not the only thing that decides whether an entry may be
replayed. There is no free-form producer field; the domain says who wrote the
entry and with which client and toolchain, and both are checked on read.

The authorization decision is bound to the domain in the same way. `authorize` is
called with the domain and must answer `{ allow: true, scope: <domain id> }`; a
bare boolean is refused, because a boolean cannot be bound to a domain and two
repositories that share one store would then read each other's entries.

### 2.3 A versioned envelope

What is stored is this transport's own envelope, not the client's bytes:

```json
{
  "v": 2,
  "kind": "adea.vp-r2-cache/entry",
  "scope": "<the trust domain id>",
  "namespace": "adea-ai/adea",
  "client": "1.3.0",
  "toolchain": "<the pinned toolchain id>",
  "key": "<base64 of the client's entry key>",
  "secondary_key": "<base64 of the client's task fingerprint key>",
  "value": "<base64 of the client's entry value>",
  "key_sha256": "<digest>",
  "secondary_key_sha256": "<digest>",
  "value_sha256": "<digest>",
  "blob_id": "<digest of the archive>",
  "blob_sha256": "<digest of the archive>",
  "blob_size": 108,
  "created_at": "2026-10-19T00:00:00.000Z"
}
```

The fields are written in a fixed order with no whitespace, so the same envelope
always produces the same bytes and two stores can be compared byte for byte. A
reader refuses an envelope whose `v` it does not know, whose `kind` is not this
kind, or which is missing a field. The version moved from 1 to 2 with the trust
domain: a version 1 envelope has no domain and is refused.

### 2.4 Object keys that a request cannot steer

Every segment is a digest or a generated identifier, so there is no request input
that reaches the key: a client key of `../../etc/passwd` still produces
`entries/<domain>/<hex>/<hex>/entry.json`. The path checks are therefore a
property of the construction, and `blobObjectKey` and `stagingObjectKey` refuse
anything that is not a digest or a generated identifier.

### 2.5 Integrity, sizes and staging

- every read is bounded (`LIMITS`: 64 KiB per key, 64 KiB per task fingerprint
  key, 4 MiB per value, 8 MiB per metadata part, 256 MiB per archive, 8 MiB per
  envelope, 300 MiB per request), each field has to be non-empty, and a store
  that returns more than the bound is refused;
- the metadata part is measured **before** it is decoded, and the decoder holds
  the message to a nesting budget (32) and an item budget (4096);
- every write is staged: the bytes land under `staging/<domain>/<ownership>`,
  the staged object is read back and compared, and only then is it promoted to
  its final key and the staging object removed. A reader never sees a half
  written object, and an interrupted write leaves nothing but a staging object,
  which is never read;
- the final object is written by **one atomic step**: a server-side copy of the
  complete staged object, or a single put of the complete bytes. Nothing is
  written to the final key in pieces;
- the publication is **fenced**. A store that can create-if-absent
  (`putIfAbsent` or `copyIfAbsent`) is asked to, and its answer says whether
  this operation created the final object. Only an object this operation
  created is removed again; a shared final key is never removed unconditionally,
  because a successor may have published it in the meantime. A store that cannot
  fence is expected to honour the cancellation signal instead, so a write whose
  operation expired never lands;
- the envelope is checked against its own digests on every read, and against the
  key that was asked for, so an envelope stored under the wrong key is refused
  instead of replayed;
- the archive is content addressed and checked against its digest when it is
  read.

### 2.6 Strict CBOR

The client's maps are decoded into **null-prototype** objects, so a key named
`__proto__` is an ordinary own property and never reaches a prototype. A map
that holds the same key twice is refused, a map key that is not text is
refused, and the fields the transport reads are read as **own** properties: a
prototype that carries `key` or `secondary_key` cannot satisfy the validation.

### 2.7 The multipart body

A multipart body is read by the complete delimiter grammar. A delimiter is a
**complete line**: the CRLF that precedes `--<boundary>`, then `--<boundary>`,
then either CRLF (a part follows) or `--` and the end of that line (the body is
closed). A candidate that is not a complete line is not a delimiter and is
skipped, so an archive keeps its bytes:

| Bytes inside a part             | What they are                              | The archive |
| ------------------------------- | ------------------------------------------ | ----------- |
| `prefix--adea-boundary--suffix` | the boundary without a CRLF in front of it | kept whole  |
| `\r\n--adea-boundary--suffix`   | a closing line that does not end there     | kept whole  |
| `\r\n--adea-boundaryX`          | a prefix of another name                   | kept whole  |

The closing delimiter must be there and must be a complete line: a body that
stops in the middle, or whose closing line is cut short, is refused rather than
read as a short part. A repeated part name is refused, and so is a part without
a name.

### 2.8 Deadlines, cancellation and safe fallback

Every external call is bounded by a deadline: the authorization call, the store
calls and the cleanup alike. A call that does not answer in time ends the
operation with a fallback.

The **whole request** runs under **one** deadline. The authorization call, the
lookup, the publication and the archive read share a single operation, so a
request cannot spend a full deadline on each of them: an authorization that took
35ms of a 50ms request leaves 15ms for the publication, and the publication is
refused rather than given a fresh deadline.

The transport's own policy is the policy: the limits and the deadline the
transport was constructed with are the ones the handler enforces. A caller may
tighten them, never loosen them, so a transport configured with
`maxBlobBytes: 4` refuses a larger upload even when the handler is called
without repeating that bound.

An operation whose deadline passed cannot publish. The staged object belongs to
that operation alone, so it is removed by an **independent bounded cleanup that
carries no signal**: a store that honours cancellation must still be able to
delete what the operation staged. A final object is removed only when this
operation is the one that created it.

Nothing throws at the caller: a refusal or a store error becomes a result with
`fallback: true` and a fixed category, and the client's own behaviour takes over

- the client reads a failed fetch as a cache miss and runs the task, and a failed
  store leaves the caller's local cache in charge. The categories are fixed strings
  that name no path, no key and no message from the store.

### 2.9 Not a public read service

`handleRemoteCache` requires an `authorize` callback. There is no default that
allows an anonymous read: a request that arrives without an authorization
decision is refused with `403` before the store is touched. The draft
public-read service is not adopted, and nothing here serves a public endpoint.

### 2.10 The adapter boundary

The handler is given a request body that the adapter has already buffered. The
adapter reads the socket, so the adapter is the party that bounds the buffering:
it must not hand over more than `LIMITS.maxRequestBytes`, and the transport
refuses a larger body with `413` before it parses anything. The replay harness's
own HTTP adapter bounds the input it buffers the same way.

## 3. The repairs review `5576644801` asked for

| #   | The review asked for                                                                                                                                | What was done                                                                                                                                                                                                                               | Where it is proved                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | a trusted namespace and a compatibility context, bound to entries, blobs and the authorization; cross-scope denial tests                            | the trust domain (`trustDomain`) is bound by `createTransport`, mixed into every key, recorded in the envelope and checked on read; the authorization answer must name the domain; a bare boolean is refused                                | `the trust domain` (6 tests), `the transport > keeps two domains apart over one store`                                                    |
| 2   | the multipart body read by the complete delimiter grammar, a closing boundary required, duplicate and malformed parts refused, arbitrary bytes kept | the parser matches `\r\n--<boundary>` only and requires the closing `--<boundary>--`; a repeated or unnamed part is refused                                                                                                                 | `the multipart body` (6 tests), including `keeps an archive that holds the boundary as plain bytes` and `keeps arbitrary bytes`           |
| 3   | non-empty per-field bounds, the metadata bounded before it is decoded, decoder budgets, the adapter boundary documented                             | `maxKeyBytes`, `maxSecondaryKeyBytes`, `maxValueBytes`, `maxMetadataBytes`; the metadata part is measured before the decode; `maxCborDepth` and `maxCborItems`; the adapter boundary is documented in the module header and in section 2.10 | `the bounds` (5 tests), `the CBOR maps`                                                                                                   |
| 4   | strict CBOR maps: null-prototype, own-property validation, duplicate-key rejection, adversarial tests                                               | the decoder builds null-prototype maps, refuses a repeated key and a non-text key; `ownField` reads only own properties                                                                                                                     | `the CBOR maps` (4 tests), `scripts/vp-r2-cache.cbor.test.ts` (13 tests), including the `__proto__` and `secondary_key` adversarial cases |
| 5   | bounded cancellable authorization, store and cleanup deadlines; stalled-operation tests; no late publish                                            | every external call is raced against the operation's deadline and the signal is handed to the store; a promotion that lands after the deadline is removed again                                                                             | `the deadlines` (4 tests)                                                                                                                 |
| -   | atomic final-object put/copy and a concurrent publication test                                                                                      | one atomic promotion step, documented; two concurrent publications of one entry are tested                                                                                                                                                  | `publishes the final object in one atomic step`, `publishes the same entry twice without leaving anything half written`                   |
| -   | a reproducible pinned-client replay that removes the local cache **and** the generated outputs                                                      | `scripts/vp-r2-cache-replay.mjs`                                                                                                                                                                                                            | section 4                                                                                                                                 |
| -   | the lower-level operations and the enabled and authenticated handler told apart                                                                     | section 2.1; the module header names both                                                                                                                                                                                                   | `createTransport` takes no authorization decision                                                                                         |
| -   | the normal repository-pinned lint, typecheck and coverage                                                                                           | section 5                                                                                                                                                                                                                                   | section 5                                                                                                                                 |

## 3.1 The repairs review `5577542289` asked for

| #                                                                                   | The review asked for                                                                                                                                                                                                         | What was done                                                                                                                                                                                                                                                                                                                         | Where it is proved                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                                                                                   | the publication fenced with adapter-enforced ownership/cancellation or conditional generation semantics; never an unconditional delete of a shared final key; an independent bounded cleanup for the operation's own staging | the promotion asks for `copyIfAbsent` or `putIfAbsent` when the store offers one, and only an object the operation created is removed; a store that cannot fence is expected to honour the cancellation signal; the staging object is removed by a cleanup that carries no signal, so a cooperative store still deletes it            | `the deadlines > an expiry during the archive promotion publishes nothing`, `an expiry during the envelope promotion leaves the entry unreadable`, `a late promotion never removes the entry a successor published` |
| 2                                                                                   | the multipart grammar to search complete delimiter lines, skip non-delimiter prefix candidates and validate the closing terminator                                                                                           | a delimiter is a complete line; a candidate that is not one is skipped, so `                                                                                                                                                                                                                                                          |
| --<boundary>--suffix`and`                                                           |
| --<boundary>X` stay inside the archive; a closing line that is cut short is refused | `the multipart body > keeps an archive that holds a boundary line as plain bytes`, `refuses a closing boundary that is not a complete line`                                                                                  |
| 3                                                                                   | the transport constructor's policy to be enforced through every handler path                                                                                                                                                 | the handler takes the transport's limits and deadline, and a caller may only tighten them (`effectiveLimits`)                                                                                                                                                                                                                         | `the transport > the transport constructor policy is enforced through the handler`                                                                                                                                  |
| 4                                                                                   | one operation and one remaining budget through the complete request                                                                                                                                                          | the authorization call, the lookup, the publication and the archive read share a single operation                                                                                                                                                                                                                                     | `the transport > the whole request runs under one deadline`                                                                                                                                                         |
| 5                                                                                   | the replay proof to require the second client exit code and to bound the buffered input                                                                                                                                      | the harness refuses a replay run that did not finish, reports both exit codes, and its HTTP adapter bounds the input it buffers                                                                                                                                                                                                       | `the pinned client replay`, `scripts/vp-r2-cache-replay.mjs`                                                                                                                                                        |
| -                                                                                   | the stale pull request metadata to be brought up to date, and the panic evidence to be told apart from the pinned checks                                                                                                     | the envelope version, the scoped keys and the file count in the pull request body and in this receipt match the code; the crash is reported separately from the pinned checks: it is recorded under the system Bun 1.4.2 and under the pinned Bun 1.4.3, while the repository-pinned checks ran under the pinned Bun 1.4.3 and passed | section 5                                                                                                                                                                                                           |

## 4. The reproducible pinned-client replay

`scripts/vp-r2-cache-replay.mjs` drives the pinned client of this checkout
against the transport, on loopback, over an in-memory store:

1. the pinned client runs a task and stores its output archive in the transport;
2. the **local task cache and the generated output file are both removed**, so
   nothing is left that could satisfy the replay locally;
3. the pinned client runs the same task again and has to fetch the entry from the
   transport.

The replay only counts when the client says it took a remote cache hit and when
the restored bytes are the bytes the first run wrote. The harness is offline and
hermetic: the project it runs in is a throwaway directory that is removed at the
end, and nothing outside it is written.

```console
$ node scripts/vp-r2-cache-replay.mjs
{
  "skipped": false,
  "client": "1.3.0",
  "runtime": ".../bun",
  "localCacheRemoved": true,
  "outputsRemoved": true,
  "remoteHit": true,
  "restored": true,
  "bytesMatch": true,
  "sha256": "72e8d47d0b8dd07fa78971c1c548bd3f884ade477cf4934cf69bb553f9faf1bb",
  "expectedSha256": "72e8d47d0b8dd07fa78971c1c548bd3f884ade477cf4934cf69bb553f9faf1bb",
  "output": "... ◉ remote cache hit, replaying ... vp run: remote cache hit, 35ms saved."
}
```

The requests the client made, as the transport saw them:

```text
POST /fetch -> 404      (the first run: nothing stored yet)
POST /store -> 200
POST /fetch -> 200      (the replay: the local cache and the output are gone)
GET  /blob/<sha256> -> 200
```

The harness runs the client through the `node` binary when there is one and
through the running runtime otherwise, and it uses the pinned `vite-plus`
package of this checkout, so it proves the contract against the client that the
repository pins.

## 5. What was run

Everything below was run offline, against loopback and in memory. No storage
service, no credential, no public endpoint and no deployment was involved.

| Command                                                                                           | Result                                                                  |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `bun test scripts/vp-r2-cache*.test.ts`                                                           | **82 pass, 0 fail**, 251 assertions                                     |
| `bun run format:check` (whole repository, pinned `oxfmt`)                                         | all matched files use the correct format                                |
| `bun run lint` (pinned `vp run orch:lint` and `oxlint --deny-warnings`, repository configuration) | 0 warnings, 0 errors                                                    |
| `bun run typecheck` (pinned `vp run orch:typecheck`)                                              | 33/33 tasks successful, "No type errors in 318 files"                   |
| `vp run orch:test` (the repository's unit task lane)                                              | **1734 tests across 135 files, 0 fail**, 32/32 tasks successful         |
| `bun test scripts/vp-r2-cache*.test.ts --coverage`                                                | aggregate 81.40% functions, 83.60% lines (the goal is 80%)              |
| `bun run test:coverage`                                                                           | **crashes** in this environment, at the base commit as well - see below |

The checks that completed ran under the **repository-pinned Bun 1.4.3** (the
version the toolchain pins) and the **repository-pinned Node 24.21.0**, both
installed for the run: `bun install --frozen-lockfile` for the dependencies, and
the Node tarball verified against the `nodejs.org` `SHASUMS256.txt`. The
coverage lane is the one exception, and it is told apart below.

The lint run uses the repository's own `.oxlintrc.json` with no rule removed:
the workspace plugin packages are installed by `bun install --frozen-lockfile`,
so `@shadcn/lint` and `@adea-ai/ui/lint` are loaded and the plugin rules are
applied.

The unit task lane is the same at the base commit `f9d5b1577`, in a separate
worktree with its own `bun install --frozen-lockfile`: **1734 tests across 135
files, 0 fail, 32/32 tasks successful**. The new test files are in the
`scripts/` lane, which the coverage lane runs.

### The coverage lane crashes here, before and after this change

`bun run test:coverage` ends in a **Bun panic** in this environment. The panic
is a Bun crash, not a test failure, and it is **not** the repository-pinned
checks above: those ran under the pinned Bun 1.4.3 and passed. The crash is
recorded under both runtimes that were tried - the system Bun 1.4.2 and the
repository-pinned Bun 1.4.3, whose crash report the run names:

```text
panic: range end index 1084 out of range for slice of length 1023
oh no: Bun has crashed. This indicates a bug in Bun, not your code.
error: script "test:coverage" was terminated by signal SIGABRT (Abort)
```

The same command at the base commit `f9d5b1577` and at the qualification base
`2498a8b7`, each in a separate worktree with its own
`bun install --frozen-lockfile`, ends the same way at the same point:

```text
panic: range end index 1077 out of range for slice of length 1023
oh no: Bun has crashed. This indicates a bug in Bun, not your code.
error: script "test:coverage" was terminated by signal SIGABRT (Abort)
```

Both runs die after about 143 seconds, in the same place, with the same docker
registry rate limits in front of them (`public.ecr.aws` and `docker.io` answer
`toomanyrequests` for the postgres image the container tests pull). The lane
therefore does not complete here, before or after this change; what is proved
here is the scripts lane, which contains the new files, and the unit task lane,
which does complete and is identical at the base commit.

The coverage of the new files, from the scripts lane:

| File                               | % Funcs | % Lines |
| ---------------------------------- | ------: | ------: |
| `scripts/vp-r2-cache.mjs`          |   91.53 |   94.79 |
| `scripts/vp-r2-cache.cbor.mjs`     |   92.31 |   98.56 |
| `scripts/vp-r2-cache-fixtures.mjs` |   89.66 |   86.83 |
| `scripts/vp-r2-cache-replay.mjs`   |   86.36 |   91.53 |

## 6. What is not claimed

- **No operational R2 completion is claimed.** No bucket, credential, account,
  endpoint or deployment was used or created. Nothing here has run against
  Cloudflare R2 or any other live store.
- **No claim is made that the task-cache SQLite files are portable.** They are
  not shipped, and this change does not make them portable. The client's
  database remains the client's own format.
- **No claim is made that the remote cache is enabled anywhere.** The transport
  is off unless `ADEA_VP_R2_CACHE_ENABLED=1` is set explicitly, and no
  repository code sets it. No workflow, script, task or configuration in this
  repository calls the transport.
- **The protocol above is the client's, not ours.** It was observed against
  `vite-plus@1.3.0`. The client owns it; a later client may change it, and the
  envelope version and the compatibility context are the seams where this
  transport would refuse to go on.
- **The replay covered one task in one throwaway project.** It shows that the
  transport is compatible with the pinned client's remote cache protocol, and
  that the restored bytes are the bytes that were written. It does not show
  that any real build graph is safe to share this way; the `apps/web build`
  task embeds its checkout's absolute path in its output and is guarded by
  `ORCH_CHECKOUT`, which is unchanged here.
- **The fallback is the local cache, always.** Whenever the remote side is
  missing, refused, unreadable or of an unknown version, the run continues on
  the local task cache and the local shared cache of `scripts/vp-local-run.mjs`.
  Nothing in this change makes a build slower or a build fail because of the
  remote cache, because the remote cache is never called by anything in the
  repository.
