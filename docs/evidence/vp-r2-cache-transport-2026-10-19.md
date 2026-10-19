# Shared R2 task-cache transport: export/import boundary and contract

Repository `adea-ai/adea`. Base `f9d5b1577ba0b0d8f932f9732b7f3867053e1c83`
(`chore(main): release 0.98.0 (#1484)`), the tip of `origin/main` when this work
started. Branch `codex/r2-task-cache-transport-w4-20261019`.

This receipt records what was proved about the pinned Vite+ client before any
transport was designed, what the transport contract in `scripts/vp-r2-cache*.mjs`
is, and what is **not** claimed.

## Scope

New files only:

| File                            | What it is                                                     |
| ------------------------------- | -------------------------------------------------------------- |
| `scripts/vp-r2-cache.mjs`       | the transport contract                                          |
| `scripts/vp-r2-cache.cbor.mjs`  | the CBOR subset the client's remote cache protocol uses         |
| `scripts/vp-r2-cache-fixtures.mjs` | synthetic fixtures and an in-memory object store             |
| `scripts/vp-r2-cache.test.ts`   | the offline proof                                               |

Nothing else in the repository changed. No workflow, no `package.json` script, no
`vite.config.ts`, no task graph and no existing script was touched. `ORCH_CHECKOUT`
(`scripts/orch-graph.mjs`) is unchanged, and the local shared cache
(`scripts/vp-local-run.mjs`) is unchanged: the transport is a separate, opt-in
contract that no current build path calls.

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
the database. What it ships is the triple the client itself exchanges with a
remote cache: the entry key, the task fingerprint key and the entry value, with
the output archive beside them as an opaque blob.

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

### 2.1 Off by default

`isEnabled` reads `ADEA_VP_R2_CACHE_ENABLED` and is false unless it is exactly
`1`. With the transport off, `handleRemoteCache` answers `503` and **makes no
store call at all** (asserted by the test that checks the store's call log is
empty). Nothing in the repository turns it on.

### 2.2 A versioned envelope

What is stored is this transport's own envelope, not the client's bytes:

```json
{
  "v": 1,
  "kind": "adea.vp-r2-cache/entry",
  "key": "<base64 of the client's entry key>",
  "secondary_key": "<base64 of the client's task fingerprint key>",
  "value": "<base64 of the client's entry value>",
  "key_sha256": "<digest>",
  "secondary_key_sha256": "<digest>",
  "value_sha256": "<digest>",
  "blob_id": "<digest of the archive>",
  "blob_sha256": "<digest of the archive>",
  "blob_size": 108,
  "created_at": "2026-10-19T00:00:00.000Z",
  "producer": null
}
```

The fields are written in a fixed order with no whitespace, so the same envelope
always produces the same bytes and two stores can be compared byte for byte.
A reader refuses an envelope whose `v` it does not know, whose `kind` is not
this kind, or which is missing a field: an unknown version is refused, never
guessed at. `ENVELOPE_VERSION` is the only thing that has to change when the
format changes.

### 2.3 Object keys that a request cannot steer

```text
entries/<sha256(key)>/<sha256(secondary_key)>/entry.json
blobs/<sha256(archive)>
staging/<generated uuid>
```

Every segment is a digest or a generated identifier, so there is no request
input that reaches the key: a client key of `../../etc/passwd` still produces
`entries/<64 hex>/<64 hex>/entry.json`. The path checks are therefore a
property of the construction, and `blobObjectKey` and `stagingObjectKey` refuse
anything that is not a digest or a generated identifier.

### 2.4 Integrity, sizes and staging

- every read is bounded (`LIMITS`: 64 KiB per key, 4 MiB per value, 256 MiB per
  archive, 8 MiB per envelope, 300 MiB per request), and a store that returns
  more than the bound is refused;
- every write is staged: the bytes land under `staging/<uuid>`, the staged
  object is read back and compared, and only then is it promoted to its final
  key and the staging object removed. A reader never sees a half written
  object, and an interrupted write leaves nothing but a staging object, which is
  never read;
- the envelope is checked against its own digests on every read, and against the
  key that was asked for, so an envelope stored under the wrong key is refused
  instead of replayed;
- the archive is content addressed and checked against its digest when it is
  read.

### 2.5 Safe fallback

Nothing throws at the caller. A refusal or a store failure becomes a result
with `fallback: true` and a fixed category, and the client's own behaviour takes
over: the client reads a failed fetch as a cache miss and runs the task, and a
failed store leaves the caller's local cache in charge. The categories are
fixed strings that name no path, no key and no message from the store.

### 2.6 Not a public read service

`handleRemoteCache` requires an `authorize` callback. There is no default that
allows an anonymous read: a request that arrives without an authorization
decision is refused with `403` before the store is touched. The draft
public-read service is not adopted, and nothing here serves a public endpoint.

## 3. What was run

Everything below was run offline, against loopback and in memory. No storage
service, no credential, no public endpoint and no deployment was involved.

| Command | Result |
| --- | --- |
| `bun test scripts/vp-r2-cache.test.ts` | 29 pass, 0 fail, 93 assertions |
| `bun test scripts/vp-r2-cache.test.ts scripts/vite-plus-proof.test.ts` | 40 pass, 0 fail |
| `bunx oxfmt@0.73.0 --check scripts/vp-r2-cache*.mjs scripts/vp-r2-cache.test.ts` | all matched files use the correct format |
| `bunx oxlint@1.88.0 --deny-warnings --config <minimal> scripts/vp-r2-cache*.mjs scripts/vp-r2-cache.test.ts` | no findings |

The lint run used the repository's own `.oxlintrc.json` with the two workspace
plugin rules removed, because `@adea-ai/ui/lint` and `@shadcn/lint` are
installed from the workspace and are not present in an uninstalled checkout;
the plugin rules are design-system rules for components and do not apply to
these files.

`scripts/vp-local-run.test.ts` has 7 failures in this environment **before**
this change (they need a `node` binary and the `vp` binary in `node_modules`);
they are unchanged by it.

### 3.1 The offline writer/reader proof

The synthetic proof in `scripts/vp-r2-cache.test.ts` drives the whole contract
against the in-memory store of `scripts/vp-r2-cache-fixtures.mjs`: an entry is
written through the client's own `POST /store` message, read back through the
client's own `POST /fetch` message, and its archive is read through
`GET /blob/<blob_id>`. The negative cases are the ones that matter for a shared
cache: a tampered value, an envelope of an unknown version, an oversized entry,
a store that refuses the write, a staged object that does not read back as it
was written, a promotion that fails, a missing entry, a request that is not
CBOR, and a request that arrives without an authorization decision.

The fixture module also carries the client's own captured messages (the fetch
request, the store request and the answer the client accepted). They are the
ground truth the transport is written against: the codec reads them, and the
answer the transport produces holds exactly the fields the client reads
(`kind`, `key`, `secondary_key`, `value`, `blob_id`).

### 3.2 The end-to-end proof against the pinned client

The transport was also served on loopback and the **real pinned client** was
pointed at it with `VP_REMOTE_CACHE_URL` and `VP_REMOTE_CACHE=read-write`. The
local task cache was deleted between the runs, so the second run could only be
served by the transport:

```console
$ rm -rf node_modules/.vite/task-cache
$ VP_REMOTE_CACHE_URL=http://127.0.0.1:8997 VP_REMOTE_CACHE=read-write vp run emit
$ bun -e "...writeFileSync('out/a.txt','hello-adea')"
Waiting for 1 remote cache upload to finish...

$ rm -rf node_modules/.vite/task-cache
$ VP_REMOTE_CACHE_URL=http://127.0.0.1:8997 VP_REMOTE_CACHE=read-write vp run -v emit
...
Statistics:   1 task • 1 cache hit (1 remote) • 0 cache misses
Performance:  100% cache hit rate, 24ms saved in total
  [1] vp-probe#emit: ... ✓
      → Remote cache hit - output replayed - 24ms saved

$ cat out/a.txt
hello-adea
```

The requests the client made, and the objects the transport held:

```text
POST /fetch -> 404
POST /store -> 200
POST /fetch -> 200
GET  /blob/0f3837400d03f01e75dc5f9e50ffb806261e5ceb90cead9694bc0c1f55e90ac6 -> 200

objects: ["blobs/0f3837400d03f01e75dc5f9e50ffb806261e5ceb90cead9694bc0c1f55e90ac6",
          "entries/07d9e693284ba4c5094f68644b2f0d5d81c056aa1926a31061151fba846fb772/d97b0388972a53fb78ff55001678e615dbfa92759bb6861cf4b5109ff351067b/entry.json"]
```

This was a loopback run against a throwaway project and an in-memory store. It
is not a claim about a deployed service.

## 4. What is not claimed

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
  envelope version is the seam where this transport would refuse to go on.
- **The end-to-end proof covered one task in one throwaway project.** It shows
  that the transport is compatible with the pinned client's remote cache
  protocol. It does not show that any real build graph is safe to share this
  way; the `apps/web build` task embeds its checkout's absolute path in its
  output and is guarded by `ORCH_CHECKOUT`, which is unchanged here.
- **The fallback is the local cache, always.** Whenever the remote side is
  missing, refused, unreadable or of an unknown version, the run continues on
  the local task cache and the local shared cache of `scripts/vp-local-run.mjs`.
  Nothing in this change makes a build slower or a build fail because of the
  remote cache, because the remote cache is never called by anything in the
  repository.
