# M18.02.2: authorized portable export and residency proof

Issue #1226 asks for proof that a workspace can be exported as a portable document through
the authenticated API, that the document carries only what the requester may read and no
credential, key, ciphertext, locator or binding, and that the document restores into a clean
destination database with the same content and the same residency. Parent: #1182.
Boundaries: #86 (artifact bytes), #189 (transient remote envelopes), #193 (synchronized
private history), #1221 (retention and archive).

This page records what this branch proves and what it does not. The status against the issue
is partial. The traceability table below says which parts are covered, which are partial and
which are not claimed.

## Surface

- `GET /api/v1/workspaces/{workspaceId}/portable-export` returns the requester's document as
  `application/json` with `cache-control: private, no-store`. A caller who is not a current
  member, a removed member, or a caller of a deleted or being-deleted workspace gets the same
  404 body as an unknown workspace id. A malformed id gets 400. A document above 8 MiB gets 413
  and is never truncated.
- `POST /api/v1/portable-imports` restores a bundle as a new workspace owned by the caller. The
  caller needs the workspace-creation permission. The body is read with a hard 8 MiB bound: a
  declared length above it, or a stream that crosses it, gets 413 before anything is written.
  Malformed JSON gets 400. A bundle that fails the contract or its digest gets 422 with issue
  paths (never values). A bundle naming a user the destination does not hold gets 422
  `unresolved_users`. A disabled importer gets 403. A workspace id that already exists, or was
  deleted, gets 409. Success gets 201 with the workspace id and content digest.

Route-flow tests are in `apps/web/test/integration/portable-workspace-routes.test.ts`, and the
API clean-restore flow is in `apps/web/test/integration/portable-workspace-clean-restore.test.ts`.
The clean-restore flow exports through the GET handler on the lane database, creates a new
database on the provisioning instance, migrates it from the repository's migrations, provisions
the users the bundle names, restores through the POST handler, and checks the digest and
residency. It then drops the database. Handlers take an injected principal resolution and
database, following the account route-flow convention. Real session resolution is covered by
the auth boundary tests, not here. The route wrappers are typed and built, but the 401 branch
lives in the wrapper and is not exercised by bun.

## What is exported (format `adea.portable-workspace-export`, version 1)

The contract is `packages/types/src/portable-export.ts`. The document is the requester's view of
one workspace: the workspace, referenced users, visible projects and their member lists,
referenced agents, visible channels and their participants, visible messages with mentions,
content-ref metadata, visible tasks, task dependencies between visible tasks, and cloud-location
execution attempts. Every record keeps its stable ID, timestamps (ISO-8601, millisecond
precision), authors, audience and links. `contentDigest` is the SHA-256 of the canonical JSON of
`content`.

Conversation order is part of the document, not of the identifiers. Each message carries
`channelOrder`, its 1-based position in its channel in the source's conversation order (the
per-channel order of `sequence`). The document lists messages by channel, then by `channelOrder`,
and the validator refuses any other order: channels ascend, and each channel's `channelOrder`
runs 1, 2, 3 with no gap. Identifiers and the order a bundle was serialized in never decide the
order, so the digest covers it. Restore inserts each channel's messages by `channelOrder`, and
the re-read that verifies the restore reproduces the same `channelOrder` values from the
destination's sequence, so a restore that changed the conversation order fails the digest check.

## Read authorization: reconciled with the canonical readers

The export does not decide audience itself. Channels and messages come from
`listChannelsForUser` and `listMessagesForUser`, the readers the workspace API serves. Whatever
gate those readers apply is applied here too. Content refs go through `isContentRefVisible`.
Tasks and projects use the project predicate the product's list readers use, and archived
projects are excluded as the default project list excludes them.

The export runs at READ COMMITTED, not in one snapshot. A REPEATABLE READ snapshot is fixed at
the first statement, so a revocation committed mid-export would be invisible to every later
check. The requester's access is checked at these points:

- At the start: role, workspace status, visible projects and visible channels.
- Before every message page: role, workspace status and visible projects. The canonical message
  reader checks membership and channel access for the page itself. If that reader refuses a
  page while the access is already gone, the refusal is reported as a denial.
- Before the tasks are read, before the content references are checked, and before the final
  check: each is a test seam (`beforeStep`) so that revocations can be placed there.
- After the last read and before the document is built: the start checks again, plus every
  channel the canonical reader served at the start.

A change that removes any part of the starting access (a removed membership, a removed channel
participant or visibility, a removed or hidden project grant, an archived channel or project, a
role change, or a deleted or being-deleted workspace) denies the whole export with the same 404
as no access. No partial document is returned.

The families are read statement by statement, so records can be seen at slightly different
moments. The digest covers exactly what was read and restores verbatim. A revocation undone
before the last check is not observed, and the bundle then holds a partial view, never records
the requester could not read when they were read. A revocation committed after the last check
is not observed either. A content ref has no grant of its own: its visibility follows the
project of its task or message channel, so revoking that project or channel revokes the ref.

Rules the export applies on its own, all conservative:

- System senders never leave under their stored identifier. A job publication's system
  identifier carries an encoded binding, so every system sender is exported as the opaque label
  `system`. A restored system message carries that label.
- Archived channels are not exported, because the canonical message readers do not serve them.
  Archived projects are not exported either, with their channels, tasks and content references,
  because the canonical project readers do not serve them. Their history stays in the product;
  an archive export belongs to retention (#1221).

Module layout: the pure mapping, the document builder and the digest live in
`packages/db/src/portable-export-content.ts`, and the pre-write bundle checks live in
`packages/db/src/portable-import-guards.ts`. Both are unit-tested without a database. The readers
that decide what a principal may see live in `portable-export.ts`, and the importer's writes live
in `portable-import.ts`; both are covered by the integration lane.

## Regression coverage

- `packages/db/tests/integration/portable-restore-order.test.ts` (3 tests) exports a channel whose
  reply sorts before its root by identifier, restores it into a clean disposable database, and
  asserts the order the canonical reader serves, the reply and thread links to the root, and the
  digest. Before this fix the restore read the conversation inverted while the digest still
  matched, because the mapper sorted by identifier before the digest was taken.
- `packages/db/tests/unit/portable-export-content.test.ts` and
  `packages/types/tests/portable-export.test.ts` cover the mapping order and the contract's
  refusal of any other message order or `channelOrder` gap.
- `packages/db/tests/integration/portable-export.test.ts` proves that the export's messages equal
  what the canonical readers serve the same principal, that an encoded job binding placed in a
  system sender, a runtime reference or a task's linked artifact references never appears in any
  export, and that an archived project leaves the export with its channel, tasks and messages.
- `apps/web/test/integration/portable-export-midstream-revocation.test.ts` (5 tests) starts the
  export through the GET handler on a two-page channel, pauses it before the second page, revokes
  the reader's membership, channel participation or project grant with the domain API, and resumes
  it. Each revocation returns 404 with the unavailable body only. Two controls with unchanged
  authority serve every message.
- `apps/web/test/integration/portable-export-revocation-matrix.test.ts` (24 tests) extends this
  to every revocation kind and to four points: between two message pages, before the tasks, before
  the content references, and before the final check.
  - Workspace membership, channel participation and members-only project grants: 4 points each
    (12 scenarios).
  - Project hidden (3 points), channel made participants-only (2), channel archived (2), project
    archived (2): 9 scenarios. The archive kinds use their own fixtures, because archiving is not
    undone through the domain API.
  - Each denial's body is exactly the unavailable body and names none of the fixture's text,
    channel, project, task or content-reference identifiers.
  - Controls with unchanged authority serve all 101 messages and the content references. A member
    who is neither listed on the members-only project nor a group participant receives none of
    those records or references.

Mutation checks on the matrix (the same filtered run, against the module with one change):

- With the final access check removed: 14 of 24 scenarios fail. Twelve return 200 where 404 is
  expected: every revocation that lands after the last per-page check. Two project-grant
  scenarios, revoked before the tasks or the content references are read, build a document that
  fails the contract self-check (`invalid_content`), so no bundle is returned. The seven
  between-pages scenarios and the three controls still pass.
- With REPEATABLE READ instead of READ COMMITTED: 21 of 24 scenarios fail, each returning 200
  where 404 is expected, including all seven between-pages scenarios. The snapshot hides the
  revocation from every later check. The three controls pass.

The matrix takes about four minutes, most of it seeding 101-message channels through the domain
API.

## Integration runners and the capture provisioning

- Canonical lane: `bun run test:integration` at the root runs `scripts/test-integration.mjs`.
  It discovers `packages/*/tests/integration` (today `packages/auth` and `packages/db`) and
  `apps/web/test/integration` (the route flow). When Docker is available it starts a throwaway
  capture instance (`postgres:18-alpine`, loopback-only port) and exports
  `MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL` to both test runs.
- CI: the code-foundry validation runtime runs the root `test:integration` script, so CI uses the
  same lane and the same provisioning.
- Package runs: `packages/db`'s `test:integration` ends with
  `scripts/run-with-capture-provisioning.mjs -- bun --conditions=react-server test tests/integration`.
  The runner starts the same instance through `scripts/capture-provisioning.mjs` and removes it
  afterwards, on a normal exit, an error, or SIGINT/SIGTERM (see Interrupt cleanup below).
  `DATABASE_URL` and `DATABASE_MIGRATION_URL` pass through unchanged.
- Without Docker the variable is not provisioned. The capture proofs skip, as documented, and
  `portable-restore-order.test.ts` fails at load with an explicit message and runs no test.
- Privilege boundaries: the application role (`DATABASE_URL`) and the migration role
  (`DATABASE_MIGRATION_URL`) are unchanged. The throwaway instance's administrator creates, migrates,
  restores into and drops the scratch database, as `portable-restore-clean.test.ts` already does. No
  grant or credential was added.
- Interrupt cleanup: the helper removes the instance it created exactly once, on a normal exit, on an
  error exit, and on SIGINT or SIGTERM. Removal is by that container's exact name. Nothing scans for or
  removes other containers, and no other process is signalled. A signal ends the process by the same
  signal after removal, and the runner re-raises the command's signal the same way. A removal that
  fails, or outlives its 30-second bound (killed with SIGKILL), names the container and fails the run.
  A natural exit whose removal fails exits 1; a failure status that is already set is kept.
- Interrupt limits: a signal that arrives during a blocking Docker call (`docker run`, the port read,
  the readiness probe, or a caller's own synchronous wait) is handled when that call returns, and the
  container is removed then. A caller that calls `process.exit` synchronously in that window exits with
  its own status rather than the signal's, and the container is still removed. SIGKILL and a host crash
  cannot be handled: the instance keeps running under its `adea-capture-prov-<hex>` name, and an
  operator removes it by that name.
- Tests: `scripts/capture-provisioning.test.ts` runs the subprocess and signal cases against a fake
  `docker` on `PATH`, so it needs no daemon and runs in the unit lane. `scripts/smoke/capture-provisioning.smoke.test.ts`
  is the one real-Docker check: one helper instance, a sentinel container with the same name shape, and
  SIGTERM. It asserts that only the helper's container is removed. The lifecycle lives in
  `scripts/smoke/capture-provisioning-run.mjs`: the sentinel name is fixed before the first side effect,
  the cleanup scope covers a refused, partial or failed start, the child is signalled only if it was
  spawned (SIGTERM, then a bounded SIGKILL), and the sentinel and the instance the child named are both
  removed by exact name, even when the other removal fails. The fault paths run without Docker in
  `scripts/capture-provisioning-smoke-faults.test.ts`, which is in the unit lane. The real-Docker test
  sits outside `scripts/*.test.ts`, so the unit lane never starts Docker. Run it through the
  heavy-validation wrapper: `fleet-heavy -- bun test scripts/smoke/capture-provisioning.smoke.test.ts`.

## End-to-end residency proof

`apps/web/test/integration/portable-residency-e2e.test.ts` (8 tests) builds the source only through
existing APIs: a workspace, a participants-only group, a members-only project with a task, content refs,
`upsertContentReplica` for an E2E-synchronized body ref, artifacts with object-store, external-harness and
native execution references, native session references on a message, a workspace invitation and a
temporary session. It exports through the GET handler as the owner, a participant and an outsider. It
restores the owner's bundle through the POST handler into a clean scratch database. No native checkpoint is
transplanted, and no replica storage is invented.

It proves:

- Source-owned audience: the owner receives the whole source view. A participant and a listed viewer
  receive their records. An outsider receives neither.
- No credential, ciphertext, locator, provenance or native reference appears in any bundle or in the
  destination. A canary test confirms the same values are in the source, so their absence is a real
  exclusion.
- Destination refusals write nothing. An existing workspace answers 409 `target_exists`. An importer without
  the creation permission gets the unavailable response, as elsewhere. A ledger class the version-1 format
  does not name answers 422 without echoing it. A digest mismatch answers 422.
- Explicit external domains: the import reports `artifact_bytes_and_locations`,
  `control_plane_identifiers`, `e2e_ciphertext_replicas`, `remote_content_envelopes` and
  `runtime_execution_state` as `unavailable`, each with its authority. This destination restores none of them.

Upstream dependencies, exact:

- Artifact bytes, locators and provenance redaction, external harness references: #86 (M20.09).
- Artifact references across workspaces: #1180 (M15.03).
- Replica restore and E2E keys: #193 (M5.11).
- Native session and checkpoint portability: no open issue exists. `docs/specs/runtime-nodes.md` excludes
  native session state from node projections, and REQ 097 keeps checkpoints to references. Restoring native
  sessions would need a new issue, not a port.

## Traceability to issue #1226 and the TDD

The issue lists requirements REQ 045, 055, 097, 140 to 145 and 177, and tests A27, A35, A36 and
A38. Their text is in the Agent HQ TDD. Status is one of covered, partial or not claimed.

| Item             | Requirement or test                                                                                                                                                        | Status              | Evidence or gap                                                                                                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1226 acceptance | Prove authorized portable export/import and end-to-end residency without credentials or private-audience leakage                                                           | Partial             | Covered: authorized export and import, clean restore, credential canaries, revocation and hidden-reference tests for the export's own readers. Not covered: pre-join content (#1232), withheld job publication (#1237), residency beyond the product database. |
| REQ 045          | Archive preserves history and links while preventing new work                                                                                                              | Partial             | Archived channels and projects are excluded from the export; the product's archive semantics are not changed here.                                                                                                                                             |
| REQ 055          | Reset, archive and delete are separate actions                                                                                                                             | Not claimed         | Conversation actions are outside the export.                                                                                                                                                                                                                   |
| REQ 097          | Credentials stay out of export, recovery and debug paths                                                                                                                   | Partial             | Export path only: canaries in `portable-export.test.ts` and `portable-restore-clean.test.ts`. Recovery, debug, logs and context preparation are not covered.                                                                                                   |
| REQ 140 to 143   | Retention classes, deletion, holds                                                                                                                                         | Not claimed (#1221) | The export omits soft-deleted and archived records. It defines no retention policy.                                                                                                                                                                            |
| REQ 144          | Stable IDs, timestamps, authors, audience and history metadata, job and attempt relationships, artifact versions and source provenance, a documented format, clean restore | Partial             | Covered: IDs, timestamps, authors, audience, history (edits and tombstones), cloud-location attempts, the documented format and clean restore. Not exported: artifact versions and source provenance (#86) and job, effect and approval evidence (#1221).      |
| REQ 145          | Residency checks: runtime state, product database, artifact store, inference, logs, external tools                                                                         | Partial             | Checked: the product database, by clean restore. Not checked: the artifact store, runtime state, logs, inference and external tools. The export sends nothing to a model or tool.                                                                              |
| REQ 177          | Destructive cleanup follows the rollback and retention gates; restoration limits are documented                                                                            | Partial             | Restoration limits are listed under residual limits. Cleanup gates belong to #1221.                                                                                                                                                                            |
| A27              | Delete or export with an offline executor and retained evidence: honest pending status; portable authorized export                                                         | Partial             | Covered: the portable authorized export. Not represented: the offline executor's pending status and retained evidence (#1221).                                                                                                                                 |
| A35              | Permanent deletion before trusted cleanup fails closed                                                                                                                     | Not claimed         | Deletion path, outside the export.                                                                                                                                                                                                                             |
| A36              | Preserve history and reconnect to supported state; no #193 expansion                                                                                                       | Partial             | No #193 dependency: replica ciphertext and key material never leave, by ledger and canary tests. Reconnect and cross-device history sync are not covered.                                                                                                      |
| A38              | Secrets stay out of recovery, export, logs and context preparation                                                                                                         | Partial             | Export path only, by canary tests. Recovery, logs and context preparation are not covered.                                                                                                                                                                     |

Pre-join content (#1232, `decideGroupHistoryRead`) and withheld job publication (#1237,
`filterVisibleJobOutboundRows`) are not on `main`. Neither the admission tables nor the
publication rows exist there, so no regression for pre-join content or withheld publication
bodies can run on this branch. The export inherits both gates through the canonical readers when
those PRs merge, because it calls the same readers. The two regressions must be added after
#1232 and #1237 land, and this PR should not merge before then. Those two regressions are not
claimed here.

## Withheld and excluded

The ledger `PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS` travels in every document. It names classes,
not counts. The table-level classification of all 41 app tables is enforced by
`packages/db/tests/unit/portable-export-classification.test.ts`: every table is carried by the
export or named in the ledger, so a new table cannot reach an export by default.

- Credentials: sessions, identity bindings, invitation tokens and emails, runtime node keys,
  exchange credentials, challenges, desktop authorization material.
- Synchronized ciphertext and its keys (#193): cloud replicas are never exported.
- Local-authority bodies: a content ref travels as metadata. Its body never travels.
- Artifact bytes, storage locators, runtime and harness references, and artifact links (#86):
  deferred until Agent HQ object storage promotion is operational.
- Native runtime state: runtime node bindings, execution references, native sessions and
  checkpoints. Only cloud-location attempts are recorded.
- Derived and personal state: events, delivery, read state, audit records, lead turn state, job
  and approval evidence (retention owned by #1221).
- Archived channels and archived projects (#1221): not served by the canonical readers.
- Soft-deleted records pending retention (#1221).
- Authority: memberships and roles. The importer becomes the owner of a restored workspace;
  bundles never grant access.

## Import

`importPortableWorkspace` validates the bundle against the contract, recomputes the digest, and
writes in one transaction into a destination that holds no such workspace (no row and no
deletion receipt). Every referenced user must already exist, and the importer must exist and be
enabled. Message bodies are restored as product-database plaintext, as stored in the source.
Content refs come back with availability `missing` (or `deleted`) and their storage and
synchronization policies unchanged; `local_only` never becomes an E2E or cloud policy. No
replica, artifact, invitation or session is written. Before commit the restored workspace is
read back with the unfiltered reader, `readCompletePortableContent`, and must reproduce the
bundle digest. A mismatch rolls the whole import back.

## Clean destination

The same clean-destination proof runs at the database layer in
`packages/db/tests/integration/portable-restore-clean.test.ts`, which creates a disposable
database on the lane's throwaway provisioning instance (`MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL`),
migrates it from the repository's migrations, provisions the users the bundle names (a restore
never creates identities), restores the bundle exported from the source database, checks the
digest and residency, refuses a second restore, and drops the database. The database name is
guarded to a fixed prefix and a random suffix. The test is skipped when that variable is absent.

## Residency

- Product database: plaintext message text and record metadata, as in the source.
- Local authority: content-ref bodies, never in a document or in the destination.
- Cloud replicas (#193): never exported or restored.
- Artifact store (#86): never exported or restored.
- Logs and events: not exported, not restored. The destination logs its own `workspace.created`
  event as any new workspace does.
- Inference and external tools: outside this format; nothing here sends workspace content to a
  model or tool. These are not checked by a residency test (REQ 145).

## Evidence and residual limits

Evidence is the test suite: the contract and import refusal unit tests, the mapping unit tests in
`packages/db/tests/unit/portable-export-content.test.ts`, the classification test, the database
integration tests (export authorization, revocation, audience, the composition with the canonical
readers, the encoded-binding regression, the archived-project exclusion, and the bound), the
route-flow tests (including the midstream and matrix revocation tests), and the clean-destination
restore tests.

Residual limits, recorded rather than claimed:

- Pre-join and publication withholding regressions are blocked on #1232 and #1237.
- The export is not one point-in-time snapshot (see Read authorization). A revocation undone
  between two checks yields a partial view, not unauthorized content. A revocation committed after
  the last check is not observed.
- Revocation coverage is workspace membership, channel participation and visibility, channel and
  project archive, and project grants and visibility, at the four points above. A content ref's
  own visibility is read-time only, and no separate content-ref grant exists.
- REQ 144 is partly met. Artifact versions and source provenance are not exported until #86
  lands: the provenance column is free-form JSON, and the restore fixture stores a storage locator
  in it, so exporting it needs a redaction contract from #86. Native checkpoints are not exported
  (REQ 097 asks that checkpoints carry references only); none are in the document.
- Offline-executor status (A27) is not represented: availability is not exported.
- System sender labels are not preserved; a restored system message carries `system`.
- Timestamps are carried at millisecond precision.
- Threaded messages are re-linked with one update each on import.
- The restored `sequence` values are the destination's own. Only the order inside each channel
  is preserved, as `channelOrder`; the absolute values differ from the source's.
- The API bound is 8 MiB per bundle. Larger workspaces are refused, not split.
- Agent profile pins are restored as stored; the destination resolves them against its own
  profile catalog.
- The clean-destination restore and the revocation matrix need the lane's database. The restore
  test is skipped when `MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL` is absent, which happens when
  Docker is unavailable.
