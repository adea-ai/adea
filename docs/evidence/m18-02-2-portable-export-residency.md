# M18.02.2: authorized portable export and residency proof

Issue #1226 proves that a workspace can be exported as a portable document through
the authenticated API, that the document carries only what the requester may read
and no credential, key, ciphertext, locator or binding, and that the document
restores into a clean destination database with the same content and the same
residency. Parent: #1182. Boundaries: #86 (artifact bytes), #189 (transient remote
envelopes), #193 (synchronized private history), #1221 (retention and archive).

## Surface

- `GET /api/v1/workspaces/{workspaceId}/portable-export` returns the requester's
  document as `application/json` with `cache-control: private, no-store`. A caller
  who is not a current member, a removed member, or a caller of a deleted or
  being-deleted workspace gets the same 404 body as an unknown workspace id. A
  malformed id gets 400. A document above 8 MiB gets 413 and is never truncated.
- `POST /api/v1/portable-imports` restores a bundle as a new workspace owned by the
  caller. The caller needs the workspace-creation permission. The body is read with a
  hard 8 MiB bound: a declared length above it, or a stream that crosses it, gets 413
  before anything is written. Malformed JSON gets 400. A bundle that fails the
  contract or its digest gets 422 with issue paths (never values). A bundle naming a
  user the destination does not hold gets 422 `unresolved_users`. A disabled importer
  gets 403. A workspace id that already exists, or was deleted, gets 409. Success
  gets 201 with the workspace id and content digest.

Route-flow tests are in `apps/web/test/integration/portable-workspace-routes.test.ts`, and the
API clean-restore flow is in `apps/web/test/integration/portable-workspace-clean-restore.test.ts`.
The clean-restore flow exports through the GET handler on the lane database, creates a new
database on the provisioning instance, migrates it from the repository's migrations,
provisions the users the bundle names, restores through the POST handler, and checks the
digest and residency. It then drops the database.
Handlers take an injected principal resolution and database, following the account
route-flow convention. Real session resolution is covered by the auth boundary tests,
not here. The route wrappers are typed and built, but the 401 branch lives in the
wrapper and is not exercised by bun.

## What is exported (format `adea.portable-workspace-export`, version 1)

The contract is `packages/types/src/portable-export.ts`. The document is the
requester's view of one workspace: the workspace, referenced users, visible projects
and their member lists, referenced agents, visible channels and their participants,
visible messages with mentions, content-ref metadata, visible tasks, task
dependencies between visible tasks, and cloud-location execution attempts. Every
record keeps its stable ID, timestamps (ISO-8601, millisecond precision), authors,
audience and links. `contentDigest` is the SHA-256 of the canonical JSON of `content`.

## Read authorization: reconciled with the canonical readers

The export does not decide audience itself. Channels and messages come from
`listChannelsForUser` and `listMessagesForUser`, the readers the workspace API serves.
Whatever gate those readers apply is applied here too. Content refs go through
`isContentRefVisible`. Tasks and projects use the same project predicate the product's
list readers use.

The export runs at READ COMMITTED, not in one snapshot: a REPEATABLE READ snapshot is
fixed at the first statement, so a revocation committed mid-export would be invisible to
every later check. The requester's access is checked in three places:

- At the start: role, workspace status, visible projects and visible channels.
- Before every message page, after the page's test seam: role, workspace status and
  visible projects. The canonical message reader checks membership and channel access
  for the page itself.
- After the last read and before the document is built: the start checks again, plus
  every channel the canonical reader served at the start.

A change that removes any part of the starting access (a removed membership, a removed
channel participant, a removed project grant, a role change, or a deleted or
being-deleted workspace) denies the whole export with the same 404 as no access. No
partial document is returned.

The families are read statement by statement, so records can be seen at slightly
different moments. The digest covers exactly what was read and restores verbatim. A
revocation undone before the last check is not observed, and the bundle then holds a
partial view, never records the requester could not read when they were read. A content
ref's own visibility is checked when it is read, not in the access check.

Two rules are the export's own, and both are conservative:

- System senders never leave under their stored identifier. A job publication's
  system identifier carries an encoded binding, so every system sender is exported as
  the opaque label `system`. A restored system message carries that label.
- Archived channels are not exported, because the canonical message readers do not
  serve them. Their history stays in the product; an archive export belongs to
  retention (#1221).

Module layout: the pure mapping, the document builder and the digest live in
`packages/db/src/portable-export-content.ts`, and the pre-write bundle checks live in
`packages/db/src/portable-import-guards.ts`. Both are unit-tested without a database. The
readers that decide what a principal may see live in `portable-export.ts`, and the
importer's writes live in `portable-import.ts`; both are covered by the integration lane.

Regression coverage: `packages/db/tests/integration/portable-export.test.ts` proves
that the export's messages equal what the canonical readers serve the same principal,
and that an encoded job binding placed in a system sender, a runtime reference or a
task's linked artifact references never appears in any export.

Mid-export revocation: `apps/web/test/integration/portable-export-midstream-revocation.test.ts`
starts the export through the GET handler, pauses it before the second message page of a
channel, revokes the reader's membership, channel participation or project grant with the
domain API, and resumes it. Each revocation returns 404 with no message text from the channel.
Two controls with unchanged authority, one group channel and one project channel, serve every
message of their channel across the same pause. Before the READ COMMITTED change the three
revocation scenarios returned 200 instead of 404.

## Blocked on #1232 and #1237: pre-join and publication withholding

The group join-point gate (#1232, `decideGroupHistoryRead`) and the job-publication
gate (#1237, `filterVisibleJobOutboundRows`) are not on `main`. Neither the admission
tables nor the publication rows exist there, so no regression for pre-join content or
withheld publication bodies can run on this branch. The export inherits both gates
through the canonical readers when those PRs merge, because it calls the same readers.
The two regressions must be added after #1232 and #1237 land, and this PR should not
merge before then. Those two regressions are not claimed here.

## Withheld and excluded

The ledger `PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS` travels in every document. It names
classes, not counts. The table-level classification of all 41 app tables is enforced by
`packages/db/tests/unit/portable-export-classification.test.ts`: every table is carried
by the export or named in the ledger, so a new table cannot reach an export by default.

- Credentials: sessions, identity bindings, invitation tokens and emails, runtime node
  keys, exchange credentials, challenges, desktop authorization material.
- Synchronized ciphertext and its keys (#193): cloud replicas are never exported.
- Local-authority bodies: a content ref travels as metadata. Its body never travels.
- Artifact bytes, storage locators, runtime and harness references, and artifact links
  (#86): deferred until Agent HQ object storage promotion is operational.
- Native runtime state: runtime node bindings, execution references, checkpoints. Only
  cloud-location attempts are recorded.
- Derived and personal state: events, delivery, read state, audit records, lead turn
  state, job and approval evidence (retention owned by #1221).
- Archived channels (#1221): not served by the canonical readers.
- Authority: memberships and roles. The importer becomes the owner of a restored
  workspace; bundles never grant access.

## Import

`importPortableWorkspace` validates the bundle against the contract, recomputes the
digest, and writes in one transaction into a destination that holds no such workspace
(no row and no deletion receipt). Every referenced user must already exist, and the
importer must exist and be enabled. Message bodies are restored as product-database
plaintext, as stored in the source. Content refs come back with availability `missing`
(or `deleted`) and their storage and synchronization policies unchanged; `local_only`
never becomes an E2E or cloud policy. No replica, artifact, invitation or session is
written. Before commit the restored workspace is read back with the unfiltered reader,
`readCompletePortableContent`, and must reproduce the bundle digest. A mismatch rolls
the whole import back.

## Clean destination

The same clean-destination proof runs at the database layer in
`packages/db/tests/integration/portable-restore-clean.test.ts`, which creates a disposable
database on the lane's throwaway provisioning instance
(`MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL`), migrates it from the repository's
migrations, provisions the users the bundle names (a restore never creates identities),
restores the bundle exported from the source database, checks the digest and residency,
refuses a second restore, and drops the database. The database name is guarded to a
fixed prefix and a random suffix. The test is skipped when that variable is absent.

## Residency

- Product database: plaintext message text and record metadata, as in the source.
- Local authority: content-ref bodies, never in a document or in the destination.
- Cloud replicas (#193): never exported or restored.
- Artifact store (#86): never exported or restored.
- Logs and events: not exported, not restored. The destination logs its own
  `workspace.created` event as any new workspace does.
- Inference and external tools: outside this format; nothing here sends workspace
  content to a model or tool.

## Evidence and residual limits

Evidence is the test suite: the contract and import refusal unit tests, the mapping unit
tests in `packages/db/tests/unit/portable-export-content.test.ts`, the
classification test, the database integration tests (export authorization, revocation,
audience, the composition with the canonical readers, the encoded-binding regression,
and the bound), the route-flow tests, and the clean-destination restore test.

Residual limits, recorded rather than claimed:

- Pre-join and publication withholding regressions are blocked on #1232 and #1237.
- The export is not one point-in-time snapshot (see Read authorization). A revocation
  undone between two checks yields a partial view, not unauthorized content.
- Revocation coverage is membership, channel participation and project grants. Changes
  to a single content ref's visibility are read-time only.
- Artifact versions and provenance (REQ 144) are not exported until #86 lands.
  Offline-executor status (A27) is not represented: availability is not exported.
- Archived channel history is not exported (see above).
- System sender labels are not preserved; a restored system message carries `system`.
- Timestamps are carried at millisecond precision.
- Threaded messages are re-linked with one update each on import.
- The API bound is 8 MiB per bundle. Larger workspaces are refused, not split.
- Agent profile pins are restored as stored; the destination resolves them against its
  own profile catalog.
- The clean-destination restore needs `MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL`. It is
  skipped when that variable is absent, which happens when Docker is unavailable.
