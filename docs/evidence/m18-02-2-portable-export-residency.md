# M18.02.2: authorized portable export and residency proof

Issue #1226 proves that a workspace can be exported as a portable document, that
the document carries only what the requester may read and no credential, key,
ciphertext or locator, and that the document restores into a clean destination
with the same content and the same residency. Parent: #1182. Boundaries: #86
(artifact bytes), #189 (transient remote envelopes), #193 (synchronized private
history).

## What is exported (format `adea.portable-workspace-export`, version 1)

The contract is `packages/types/src/portable-export.ts`. The document is the
requester's view of one workspace: the workspace, referenced users, visible
projects and their member lists, referenced agents, visible channels and their
participants, visible messages with mentions, content-ref metadata, visible
tasks, task dependencies between visible tasks, and cloud-location execution
attempts. Every record keeps its stable ID, timestamps (ISO-8601, millisecond
precision), authors, audience and links. `contentDigest` is the SHA-256 of the
canonical JSON of `content`.

## Authorization

- `exportPortableWorkspace` needs a current workspace membership, read in the
  same repeatable-read, read-only snapshot as the content. A removed membership,
  a non-member, a deleted workspace and a workspace whose deletion is requested
  all fail with the same `denied` error.
- Audience is the product's read model: members-only projects follow
  `resolveProjectAccessScope`; participants-only channels require a participant
  row; tasks follow the project scope, as `listTasksForUser` does.
- A link from an exported record to a record that is not exported (a hidden task,
  a participant-only channel, a hidden message) is cleared to null. Counts are
  never disclosed. Exports above `PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS` per family
  fail closed with `too_large`.

## Withheld and excluded

The ledger `PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS` travels in every document. It
names classes, not counts. The table-level classification of all 41 app tables
is enforced by `packages/db/tests/unit/portable-export-classification.test.ts`:
every table is either carried by the export or named in the ledger, so a new
table cannot reach an export by default.

- Credentials: sessions, identity bindings, invitation tokens and emails, runtime
  node keys, exchange credentials, challenges, desktop authorization material.
- Synchronized ciphertext and its keys (#193): cloud replicas are never exported.
- Local-authority bodies: a content ref travels as metadata (digest, sensitivity,
  synchronization policy, body state). Its body never travels.
- Artifact bytes, storage locators, runtime and harness references, and artifact
  links (#86): deferred until Agent HQ object storage promotion is operational.
- Native runtime state: runtime node bindings, execution references, checkpoints.
  Only cloud-location attempts are recorded.
- Derived and personal state: events, delivery, read state, audit records, lead
  turn state, job and approval evidence (retention owned by #1221).
- Authority: memberships and roles. The importer becomes the owner of a restored
  workspace; bundles never grant access.

## Import

`importPortableWorkspace` validates the bundle against the contract, recomputes
the digest, and writes in one transaction into a destination that holds no such
workspace (no row and no deletion receipt). Every referenced user must already
exist; the importer must exist and be enabled. Message bodies are restored as
product-database plaintext, as stored in the source. Content refs come back with
availability `missing` (or `deleted`) and their storage and synchronization
policies unchanged; `local_only` never becomes an E2E or cloud policy. No replica,
artifact, invitation or session is written. Before commit the restored workspace
is read back with the unfiltered reader and must reproduce the bundle digest; a
mismatch rolls the whole import back.

## Residency

- Product database: plaintext message text and record metadata, as in the source.
- Local authority: content-ref bodies, never in a document or in the destination.
- Cloud replicas (#193): never exported or restored.
- Artifact store (#86): never exported or restored.
- Logs and events: not exported, not restored; the destination logs its own
  `workspace.created` event as any new workspace does.
- Inference and external tools: outside this format; nothing here sends workspace
  content to a model or tool.

## Evidence and residual limits

Evidence is the test suite: unit tests for the contract and the import refusals,
the classification test, and the integration tests in
`packages/db/tests/integration/portable-export.test.ts`. The integration tests
seed canary values for each excluded class and assert that no export carries
them, that a member sees only the entitled audience, that revocations take
effect at the next export, and that a restored workspace reproduces the digest
with no residency change.

Residual limits, recorded rather than claimed:

- The clean-destination restore runs in the same database after the source
  workspace is removed. A run in a separate database was not executed: the
  integration lane's application roles do not hold CREATEDB (see the comment in
  `scripts/test-integration.mjs`).
- Timestamps are carried at millisecond precision; sub-millisecond source
  precision is not preserved.
- Threaded messages are re-linked with one update each on import.
- No HTTP route or client surface exposes the export or import yet; both are
  server functions in `@adea-ai/db`.
- Artifact bytes, artifact references and E2E replica history are outside v1
  until #86 and #193 land.
