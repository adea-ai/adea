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
  deleted, gets 409. Success gets 201 with the workspace id and validated bundle digest. Import
  verifies using the bundle's display-name snapshots without overwriting destination profiles;
  later exports may hash differently if those names differ.

Route-flow tests are in `apps/web/test/integration/portable-workspace-routes.test.ts`, and the
API clean-restore flow is in `apps/web/test/integration/portable-workspace-clean-restore.test.ts`.
The clean-restore flow exports through the GET handler on the lane database, creates a new
database on the provisioning instance, migrates it from the repository's migrations, provisions
the users the bundle names, restores through the POST handler, and checks the digest and
residency. It then drops the database. Handlers take an injected principal resolution and
database, following the account route-flow convention. Those files therefore do not exercise the
route wrappers or the principal resolver. The authenticated request path is proven separately in
`apps/web/test/integration/portable-export-authenticated-path.test.ts`; see
[Authenticated request-path proof](#authenticated-request-path-proof).

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
- Before every task page: role, workspace status and visible projects. Tasks use an ID cursor,
  read 25 at a time, and select only fields the export carries. The UTF-8 JSON lower bound from
  each task's objective and title is checked before retaining that row. Agent and user references
  are read in 100-ID batches and projected to exported fields. Agent names and role summaries
  join the same byte budget; SQL withholds both agent text columns once their cumulative
  lower bound exceeds the remaining budget. User-name byte lengths are also checked in SQL before
  name values are transferred to the Worker.
- Task title/objective and message body text are projected in SQL against the remaining document
  byte budget before either text value reaches the Worker. For each task page (at most 25 rows), SQL
  sums the compact JSON UTF-8 lower bound in task-ID order and returns title/objective only for rows
  within that budget; the first and later over-budget rows return null text with
  `withinByteBound = false` and cause `too_large` before retention or document construction.
  Message pages first fetch row metadata with
  `bodyText = NULL`, apply the canonical membership, channel, job-visibility and group-history
  gates, then project only visible, nondeleted, non-content-ref bodies whose cumulative JSON UTF-8
  bytes fit. An over-budget body is withheld and causes refusal; text is never truncated or
  returned as a complete partial export. The final retained-message proof repeats the bounded body
  projection after current visibility checks and denies if a body is withheld before exact summary
  comparison.
- Final retained-task proof selects only `id`, `version`, `projectId` and `objectiveContentRefId`
  for the retained task IDs. It does not select title/objective, so oversized text edits are not
  materialized in that proof. A task edit through `updateTask` increments `version` and is denied by
  the proof; a text edit that bypasses version increments is not detected because the proof does
  not re-read or compare those text fields.
- These checks bound exported text contributions and prevent the task title/objective and message
  body columns from being transferred to the Worker beyond the remaining byte budget; they do not
  impose an 8 MiB process-heap or source-database work ceiling. Bounded pages, row metadata,
  references, other included fields, and runtime/driver overhead still consume memory. Agent names
  and role summaries are also conditionally projected in SQL before transfer to the Worker.
- Before the task pages begin, before the content references are checked, and before the final
  check: each is a test seam (`beforeStep`) so that revocations can be placed there.
- After the last read and before the document is built: the start checks again, plus every
  channel the canonical reader served at the start.

A change that removes any part of the starting access (a removed membership, a removed channel
participant or visibility, a removed or hidden project grant, an archived channel or project, a
role change, or a deleted or being-deleted workspace) denies the whole export with the same 404
as no access. No partial document is returned.

The families are read statement by statement, so records can be seen at slightly different
moments. Project and channel IDs are restricted to the authorization sets captured when the
export starts; IDs that become visible later are not added. The digest covers the resulting
document snapshot. A revocation undone before the last check is not observed for the starting
access set. A revocation committed after the last check is not observed either. A content ref
has no grant of its own: its visibility follows the project of its task or message channel, so
revoking that project or channel revokes the ref.

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
- `apps/web/test/integration/portable-workspace-routes.test.ts` also revokes a membership between
  task pages and proves the next page is denied, and tests early refusal plus a valid task-heavy
  export near the 8 MiB bound. Its oversized identity-provider display-name regression asserts a
  413 response. `packages/db/tests/integration/portable-export-channel-bounds.test.ts` now covers
  the SQL-side byte projection directly: it proves a database-valid agent name that crosses the
  remaining budget is withheld after a near-cap role summary, and a role summary above the full
  cap is withheld. Its test seam records only encoded byte counts for the projected columns; each
  case also asserts `too_large`. The name is kept within the database index limit, while the
  paired role summary makes the row cross the remaining budget.

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
  removed by exact name, even when the other removal fails. OWNED and READY are read only as complete
  lines. An inspection that fails for any reason other than Docker's absent-container answer for that
  name is an error, never proof of removal. The fault paths run without Docker in
  `scripts/capture-provisioning-smoke-faults.test.ts`, which is in the unit lane. The real-Docker test
  sits outside `scripts/*.test.ts`, so the unit lane never starts Docker. Run it through the
  heavy-validation wrapper: `fleet-heavy -- bun test scripts/smoke/capture-provisioning.smoke.test.ts`.

## End-to-end residency proof

`apps/web/test/integration/portable-residency-e2e.test.ts` (10 tests) builds the source only through
existing APIs: a workspace, a participants-only group, a members-only project with a task, content refs,
`upsertContentReplica` for an E2E-synchronized body ref, artifacts with object-store, external-harness and
native execution references, native session references on a message, a workspace invitation and a
temporary session. It exports through the GET handler as the owner, a participant and an outsider. It
restores the owner's bundle through the POST handler into a clean scratch database. No native checkpoint is
transplanted, and no replica storage is invented.

The successful GET and POST response helpers run under a temporary `globalThis.fetch` tripwire;
both record zero calls. A synthetic fetch positive control proves the tripwire blocks and counts a
call. This instrumentation covers JavaScript calls through `globalThis.fetch` only. It does not
intercept Postgres connections, raw sockets, native clients or other non-fetch transports, and is
not comprehensive network isolation.

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
- Fetch boundary: the portable export and import response helpers make zero intercepted
  `globalThis.fetch` calls in the successful clean-restore fixture.

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

| Item             | Requirement or test                                                                                                                                                        | Status              | Evidence or gap                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1226 acceptance | Prove authorized portable export/import and end-to-end residency without credentials or private-audience leakage                                                           | Partial             | Covered: authorized export/import, clean restore, credential and audience canaries, revocation, pre-join history and withheld job-publication regressions through the canonical readers, and the same through the real authenticated GET and POST routes (see the section below). Not covered: residency beyond the product database; the Neon-account and temporary-credential resolver branches; mid-stream revocation through the route. |
| REQ 045          | Archive preserves history and links while preventing new work                                                                                                              | Partial             | Archived channels and projects are excluded from the export; the product's archive semantics are not changed here.                                                                                                                                                                                                                                                                                                                          |
| REQ 055          | Reset, archive and delete are separate actions                                                                                                                             | Not claimed         | Conversation actions are outside the export.                                                                                                                                                                                                                                                                                                                                                                                                |
| REQ 097          | Credentials stay out of export, recovery and debug paths                                                                                                                   | Partial             | Export and import paths: canaries in `portable-export.test.ts`, `portable-restore-clean.test.ts` and, on the raw response bytes and a full-table scan of each destination, `portable-export-authenticated-path.test.ts`. Recovery, debug, logs and context preparation are not covered.                                                                                                                                                     |
| REQ 140 to 143   | Retention classes, deletion, holds                                                                                                                                         | Not claimed (#1221) | The export omits soft-deleted and archived records. It defines no retention policy.                                                                                                                                                                                                                                                                                                                                                         |
| REQ 144          | Stable IDs, timestamps, authors, audience and history metadata, job and attempt relationships, artifact versions and source provenance, a documented format, clean restore | Partial             | Covered: IDs, timestamps, authors, audience, history (edits and tombstones), cloud-location attempts, the documented format and clean restore. Not exported: artifact versions and source provenance (#86) and job, effect and approval evidence (#1221).                                                                                                                                                                                   |
| REQ 145          | Residency checks: runtime state, product database, artifact store, inference, logs, external tools                                                                         | Partial             | Checked: product-database clean restore and zero `globalThis.fetch` calls through the portable response helpers. Not checked: actual artifact-store/runtime state, logs, inference or external tools; the fetch probe does not cover other transports.                                                                                                                                                                                      |
| REQ 177          | Destructive cleanup follows the rollback and retention gates; restoration limits are documented                                                                            | Partial             | Restoration limits are listed under residual limits. Cleanup gates belong to #1221.                                                                                                                                                                                                                                                                                                                                                         |
| A27              | Delete or export with an offline executor and retained evidence: honest pending status; portable authorized export                                                         | Partial             | Covered: the portable authorized export. Not represented: the offline executor's pending status and retained evidence (#1221).                                                                                                                                                                                                                                                                                                              |
| A35              | Permanent deletion before trusted cleanup fails closed                                                                                                                     | Not claimed         | Deletion path, outside the export.                                                                                                                                                                                                                                                                                                                                                                                                          |
| A36              | Preserve history and reconnect to supported state; no #193 expansion                                                                                                       | Partial             | No #193 dependency: replica ciphertext and key material never leave, by ledger and canary tests. Reconnect and cross-device history sync are not covered.                                                                                                                                                                                                                                                                                   |
| A38              | Secrets stay out of recovery, export, logs and context preparation                                                                                                         | Partial             | Export and import paths only, by canary tests including the authenticated-path scans. Recovery, logs and context preparation are not covered.                                                                                                                                                                                                                                                                                               |

Merged PR #1245 composes the export with the canonical group-history and job-publication readers.
`packages/db/tests/integration/portable-export.test.ts` includes the regressions `a group member
who joined after earlier history never receives it, and the founder does` and `a job publication the
readers withhold, and its encoded binding, never leave in an export`. These behaviors are covered on
current main and no longer block the portable export proof.

## Withheld and excluded

The ledger `PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS` travels in every document. It names classes,
not counts. The table-level classification of every app-schema table is enforced by
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
- Derived and personal state: events, delivery, read state, audit records and lead turn state.
- Job/effect/approval evidence: job effects, digest-only management decision claims (including
  `management_authority_consumptions`) and approval evidence are retained under #1221 and not
  restored.
- Archived channels and archived projects (#1221): not served by the canonical readers.
- Soft-deleted records pending retention (#1221).
- Authority: memberships and roles. The importer becomes the owner of a restored workspace;
  bundles never grant access.

## Import

`importPortableWorkspace` validates the bundle against the contract, recomputes the digest, and
writes in one transaction into a destination that holds no such workspace (no row and no
deletion receipt). Every referenced user ID must already exist, and the importer must exist and
be enabled. `PortableUser.displayName` is an export-time snapshot: import never overwrites a
destination user's global profile. Before commit, the unfiltered reader verifies workspace-owned
content and the exact referenced-user ID set; destination display names are normalized to the
bundle snapshots for this digest check. A normal read or later export can therefore have a
different raw digest if destination names differ. Any other mismatch rolls the transaction back.
Message bodies are restored as product-database plaintext, as stored in the source. Content refs
come back with availability `missing` (or `deleted`) and their storage and synchronization
policies unchanged; `local_only` never becomes an E2E or cloud policy. No replica, artifact,
invitation or session is written.

## Clean destination

The same clean-destination proof runs at the database layer in
`packages/db/tests/integration/portable-restore-clean.test.ts`, which creates a disposable
database on the lane's throwaway provisioning instance (`MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL`),
migrates it from the repository's migrations, provisions the users the bundle names (a restore
never creates identities), restores the bundle exported from the source database, checks the
normalized readback digest and residency, refuses a second restore, and drops the database. The
database name is guarded to a fixed prefix and a random suffix. The test is skipped when that
variable is absent.

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

- The route egress probe intercepts only JavaScript `globalThis.fetch`; it is not a comprehensive
  network-isolation test and does not inspect external service state, logs or native transports.
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

## Local verification checkpoint (2026-10-12)

The incremental repair based on published head `248f8f0ae3c72e17d394f69f511ab2079941581d`
changes only agent-name and role-summary residency during export. SQL computes their cumulative
UTF-8 byte bound and returns `NULL` for both text columns on the first row that crosses the
remaining budget and for later rows. The integration hook measures encoded byte counts only; it
does not expose the text values. It proves both the over-budget name case and an over-cap role
summary case are refused before those values reach the Worker.

Fresh validation in the saved executor:

- `bun run test:integration` passed: 337 tests across 53 auth/database integration files, then
  148 tests across 10 API route files (485 tests total). The required
  `portable-restore-order.test.ts` ran with the capture-provisioning database; all five assertions
  passed, including the clean destination and its distinct-database check.
- `bun run --cwd packages/db typecheck`, `bun run --cwd packages/db lint`, `oxfmt --check` on
  both changed TypeScript files, and `git diff --check` passed.
- This executor has no host `psql`; the canonical health check used a temporary adapter that
  invokes `psql` inside the already-running local PostgreSQL container. The repository runner
  provisioned and removed its disposable capture database. No credential or role settings were
  changed.

This checkpoint closed only the pre-transfer bound for agent names and role summaries. Its
remaining-gap note is historical: merged PR #1245 added the canonical group-history and
job-publication export regressions listed above. Issue #1226 remains partial because it does not
verify residency in artifact storage, replicas, logs or native runtime state.

## Authenticated request-path proof

`apps/web/test/integration/portable-export-authenticated-path.test.ts` drives the production route
handlers (`Route.server.handlers.GET` for `/api/v1/workspaces/{id}/portable-export` and `POST` for
`/api/v1/portable-imports`) with real `Request` objects, the real origin guard, the real
`resolveWorkspacePrincipal`, the real per-request database client and the real PostgreSQL
membership and audience readers. Its only seam is an identity `createFileRoute`, the same one the
other route-flow files use so route modules load under bun. The principal is not injected. Callers
are identified by desktop sessions issued by the production `desktopSessionService()` and presented
with the production header contract (`Authorization: Desktop`, `X-Adea-Desktop-Session`, a trusted
`Origin`, `X-Adea-Client`). Sessions belong to real, non-temporary users.

What it adds to the helper-level proofs above:

- **Rejected callers, export and import alike.** Missing credential, wrong credential, another
  user's session id, expired session, revoked session, disabled account, malformed scheme, an
  untrusted origin, a missing origin and an account-allowlist denial all end at the wrapper or the
  resolver. The seven credential failures return one byte-identical 401 body for both routes, no
  `Set-Cookie`, no canary and no credential material, and an import refused this way writes no
  row. An untrusted origin gets 403 with no `Access-Control-Allow-Origin`.
- **Private-audience canaries on the wire.** Status, headers and body of every response are scanned
  for the artifact locator and provenance, execution and native session references, the replica
  ciphertext, the invitation token and email, and each caller's credential, credential digest,
  provider email and provider session id. An owner and a participant receive the participants-only
  group and the members-only project text; a workspace member outside both receives the
  workspace-wide text and neither private text, and the group is absent from the channel list. An
  authenticated non-member gets the same 404 body as an unknown workspace id and the id is not
  echoed.
- **Revocation between requests.** Removing a group participant, removing a workspace member,
  revoking the desktop session, disabling the account and revoking an importer's session each end
  the next response (empty of the previously readable text, 404, 401, 401 and 401 respectively).
  The participant case uses a text sent after admission, because pre-join history is already
  withheld by the canonical reader (#1232).
- **Import through the authenticated POST route into brand-new databases.** Two scratch databases
  are created on the provisioning instance and migrated from the repository's migrations. For each,
  an importer session is issued by the same production service against that database
  (`DATABASE_URL` is pointed at it only for the call). The owner's bundle first meets a destination
  that lacks the other users and is refused 422 `unresolved_users` with nothing written; after
  those users exist it restores with 201, the digest matches the bundle, the destination's own GET
  re-exports the same digest, every external domain is reported unavailable, and a second POST is 409. Every table of the destination is dumped and searched for the source canaries: nothing
  leaks, no replica, artifact or invitation exists, the only membership is the importer as owner,
  and every restored content ref is `missing`. The outsider's bundle, restored the same way, leaves
  no private group or members-only text anywhere in its destination and no group channel row.
- **Refusals write nothing and echo nothing.** Through the route: existing workspace 409, edited
  text 422 `digest_mismatch`, an unnamed ledger class 422, malformed JSON 400, a declared length
  over the bound 413 and an undeclared stream over the bound 413. Neither the edited text nor the
  unnamed class appears in any refusal body, and the source rows are unchanged.
- **Route-level fetch fence.** An authenticated GET, an authenticated POST refusal and an
  authenticated restore into a scratch database each make zero `globalThis.fetch` calls; the fence's
  positive control counts one. This is still a fetch-only probe: it does not see Postgres sockets
  or other transports, so it is evidence about JavaScript fetch egress, not network residency.

Teardown deletes every user the file created in the lane database (each person is recorded when
created, so a later test needs no cleanup of its own), together with their desktop sessions and
auth identities, and then fails the file if any user, identity or session carrying this run's
marker remains. Destination persons live in scratch databases that are dropped whole. Two
consecutive local runs left 0 users, identities, sessions, workspaces and scratch databases; with
the tracking removed, the guard failed with 12 leftovers.

Mutation checks run while writing the file (each reverted afterwards; the expected cases failed):
allowlist ignored (1 failure), origin guard disabled (1), denied callers answered 403 with the id
(2), a credential echoed in a response header (2), session revocation ignored (4), disabled-account
check ignored (2) and session expiry ignored (1).

Findings worth recording:

- `workspace.create` with no workspace is allowed for any user principal
  (`packages/auth/src/authorization.ts`), so through the real route an importer without the
  creation permission cannot occur. The refusal an importer can meet is a failed principal
  resolution (401) or a disabled importer (`importer_unavailable`, 403, covered at the database
  layer). The helper-level test that injects `async () => false` exercises the 404 wrapper branch
  only, not a product-reachable state.
- The restored workspace's content refs keep their source `synchronization_policy` (for example
  `agent_hq_e2ee_sync`) with `availability = missing` and no replica row. That is metadata, and the
  proof asserts the absence of bodies and replicas, not a policy downgrade.

Not covered by this file (remaining gaps for #1226):

- Mid-stream revocation inside one export request. The route does not expose the `hooks` seam; that
  behavior stays proven at the helper level in `portable-export-midstream-revocation.test.ts`.
- The Neon-account and temporary-credential branches of `resolveWorkspacePrincipal`. They need the
  framework request context and a provider session; only the desktop-session branch is driven.
- Cloudflare Worker runtime behavior (Hyperdrive binding, request-scoped environment), `Set-Cookie`
  for first-visit temporary sessions, and any CDN or proxy layer between a client and the Worker.
- Residency in the artifact store, replicas, logs, inference and native runtime state, as above.

Run: `DATABASE_URL=... MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL=... bun --conditions=react-server test
--timeout 120000 apps/web/test/integration/portable-export-authenticated-path.test.ts`, or through
`bun run test:integration`, which discovers the file with the other route flows. It fails, not
skips, when either variable is missing.

## Current-main isolation and restore proof (incorporated in #1245)

The behavior recorded below is present in merged PR #1245 (merge commit
`58958d7fe3f832cda16dc3ed4407457b022fe84a`). Earlier local candidate hashes and unpublished
status notes are historical and do not describe current main.

Orchestration reads use short READ COMMITTED transactions and release the pool connection before
hooks or canonical page snapshots. Channels and messages are projected in their canonical coherent
snapshots. Group summaries use effective admissions, not legacy participant rows; sequence cursors
advance over raw scanned rows even when a whole page is withheld. Final verification uses one
READ WRITE / REPEATABLE READ snapshot so the existing share locks are legal, and checks buffered
channel summaries, message projections, task identities/versions/parents and visible content-ref
bindings before building the bundle. Missing or changed required records refuse the entire export.
The final authorization point is the coherent final snapshot, not a claim of perpetual authority
after response delivery. No application rows are written by export.

The ordinary channel/participant size fixtures now use actual project channels. They retain the
original record, materialization, statement and byte assertions. Separate real-group tests prove
pre-join withholding, admission and earlier-history revocation, expiry, empty-page progress and
canonical snapshot isolation. Source-authority and artifact-grant changes before the final proof
refuse buffered publications and reply ancestry. A one-connection PostgreSQL pool exercises content
references and actual share locks, and records zero INSERT/UPDATE/DELETE/DDL statements during export.
The four newly landed group authority tables are explicitly excluded under the existing version-1
`authority_grants` class; source grants and admissions are not transplanted.

The previously recorded missing-destination-admission blocker is resolved in #1245. Import creates
fresh restore-scoped audience/enlistment grants and admissions for the bundle's listed group
participants; it does not copy source grants or admit an unlisted importer. The clean-restore and
edited-`exportedBy` regressions in `portable-export.test.ts` verify those join points and reads.
Issue #1226 remains open and partial because residency outside the product database is not fully
checked; the fetch tripwire above covers `globalThis.fetch` only.
