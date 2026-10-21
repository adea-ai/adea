# M18.02.2 residual acceptance: authorized portable export and residency (#1226, #1182)

Status: issue **#1226 stays open and partial**. Issue **#1182 stays a rollup**: this file adds
evidence under it and closes nothing under it.

Merged PR #1245 built the export and the restore, and merged PR #1372 proved the authenticated
request path. Both are on current main and neither is rebuilt here. What is left for #1226 is the
part that a merged implementation cannot settle by itself: a single disposable round trip that
states, record by record, what a workspace's export actually carries, what it deliberately does not
carry, what a destination ends up holding, and which stores were never touched at all.

This file records that round trip. It is the evidence for a new test file and nothing else:

- `apps/web/test/integration/portable-export-residual-residency.test.ts` (19 tests)
- this document

No product source, no shared group or migration file, no UI, no credential and no deployment
changed. The base was `ee31982e70406ab5de447a79603d6545ac11359f` on branch
`codex/f3w4-adea-20261021`, verified clean before the first edit and after the last.

## The fixture

One disposable source workspace, built only through product APIs, with an audience that has three
distinct answers:

| Element           | What it is                                                                                                                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner             | workspace owner, participant of the group, creator of both projects and of the task graph                                                                                                                                               |
| Member            | workspace member, listed on both projects, participant of the group, holder of a group grant                                                                                                                                            |
| Outsider          | workspace member, listed on neither project, not a participant of the group                                                                                                                                                             |
| Revoked           | workspace member whose membership is removed mid-file                                                                                                                                                                                   |
| Group             | participants-only channel with an audience grant per human and an enlistment grant for an Agent                                                                                                                                         |
| Visible project   | workspace-visible, with a channel, seven messages, two tasks and one task dependency                                                                                                                                                    |
| Members project   | members-only, with a channel, one message and one task                                                                                                                                                                                  |
| Artifact          | an object-store artifact with a locator and provenance, and an external-harness artifact, both linked from one message and granted to a second workspace                                                                                |
| Content refs      | a body the local authority holds, a body it holds but cannot serve, a body it does not hold, a deleted body, an E2E-synchronized body with a cloud replica, a task objective body and a task objective body in the members-only project |
| Execution attempt | one cloud-location attempt on the task graph                                                                                                                                                                                            |
| Invitation        | a workspace invitation, so a credential and an email exist in the source                                                                                                                                                                |
| Publication       | a job publication: a system sender whose stored identifier is an encoded binding of the acting user, the job and its workspace                                                                                                          |
| Tombstone         | a message the workspace removed, kept with the time of its removal                                                                                                                                                                      |

The three audience texts are distinct: a workspace-visible text, a members-only text and a
participants-only group text. The content references cover every state the local authority can
report — held, held but not servable, not held, and removed — so the document's statement about
each state is proved rather than assumed. The canaries are the artifact locator, the artifact provenance, the
external-harness reference and harness id, the artifact reference grant id, the execution reference,
the replica ciphertext and nonce, the invitation email, the invitation token digest and the session
credential digest. Every one of them is asserted to be present in the source before its absence
anywhere else is asserted, so an absent canary is a real exclusion rather than a value that was
never there.

Three disposable destination databases are created on the lane's throwaway provisioning instance,
migrated from the repository's migrations, and dropped again. The owner's bundle is restored into
one, the outsider's bundle into a second, and the third stays empty for the refusal cases. Each is
created when the first test that needs it runs, because a full schema migration is heavy work and
the route-flow lane runs its files in parallel against one database instance; the reason is
recorded under the commands below.

## What the round trip proves

The evidence classes below are the ones this file adds. Everything already proved by the merged
files is cited, not repeated.

| Class | Claim                                                                                                                                                                                                 | Where                                                                                                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1    | The authorized bundle is nonempty in every family the format claims to carry                                                                                                                          | `the authorized bundle is nonempty in every family the format claims to carry`                                                                                     |
| E2    | The bundle lists the messages in the order the canonical reader serves them, and the restore reproduces it                                                                                            | `the bundle lists the messages in the order the canonical reader serves them`, `the restore reproduces the order, the links and the digest of the bundle`          |
| E3    | The audience matrix: owner, listed member and outsider each receive exactly their own audience                                                                                                        | `the audience matrix gives each reader exactly their own audience`                                                                                                 |
| E4    | Revocation: a revoked group grant removes the group and its text; a removed membership is refused indistinguishably                                                                                   | `a revoked group audience grant removes the group and its text from the next bundle`, `a removed membership is refused with the same body as an unknown workspace` |
| E5    | Artifact references do not travel and the withheld domain is named, not silently lost                                                                                                                 | `artifact references do not travel, and the withheld domain is named`                                                                                              |
| E6    | The source's grants are never transplanted; the restore issues its own                                                                                                                                | `the source grants are never transplanted; the restore issues its own`                                                                                             |
| E7    | The residency classification, and the actual stores the restored workspace occupies                                                                                                                   | `the restored workspace lives in an enumerated set of stores and nowhere else`, `the stores without a workspace column hold only the provisioned identities`       |
| E8    | Offline and withheld content is stated honestly, and every external domain is reported unavailable                                                                                                    | `the withheld external domains are reported unavailable and the offline bodies are stated honestly`                                                                |
| E9    | Malicious manifests, ordering and collision errors are refused and write nothing                                                                                                                      | `a malicious manifest is refused and writes nothing`, `ordering and collision errors are refused and write nothing`                                                |
| E10   | A manifest that claims another exporter's authority transfers no authority                                                                                                                            | `a manifest claiming another exporter's authority does not transfer authority`                                                                                     |
| E11   | Secret canaries are in the source and in no bundle and in no destination; private plaintext reaches the authorized reader and nobody else                                                             | `the secret canaries are in the source and in no bundle and in no destination`, `the private plaintext reaches the authorized reader and no one else`              |
| E12   | The source, the document and the restored workspace agree on the order of every channel, and the document's own position is that order                                                                | `the source, the export and the import agree on the order of every channel`                                                                                        |
| E13   | The document carries the authorized content and its provenance unchanged: authorship, timestamps, versions, tombstones, body states, reference metadata, task fields, profile pins and project fields | `the export carries the authorized content and its provenance, unchanged`                                                                                          |
| E14   | The body states are stated exactly, and a reference the reader may not know about is absent from that reader's document                                                                               | `the body states and the unknown-to-the-reader case are stated exactly`                                                                                            |

### E2, the order and the links

The bundle's `channelOrder` is checked twice: once against the document's own rule (channels
ascend, each channel is one contiguous run, `channelOrder` runs 1, 2, 3 with no gap), and once
against the source. For every channel the bundle names, the canonical reader is asked for the same
channel and the two id lists must be identical. The restore is then read back through the same
canonical reader and must serve the same order, and every reply and thread link must match the
bundle's.

### E5, artifact references

The source holds two artifacts: one in the object store, with a locator and provenance, and one held
by an external harness, with its own harness id. The members-only lane's message references both of
them, and the object-store artifact is granted to a second workspace by a cross-workspace artifact
reference grant. None of the artifact ids, locators, harness ids, provenance, execution reference or
grant id appears in the bundle. The import reports `artifact_bytes_and_locations` as `unavailable`,
with the authority `artifact_store (#86)` and the treatment `deferred`. The destination holds no
artifact row, no message artifact reference and no artifact reference grant.

### E6, grants

The source's audience grants have ids this file controls (`residual-audience-…`,
`residual-enlistment-…`). None of them appears in the bundle. The destination's audience grants
are minted by the importer as `restore:audience:<userId>` and its enlistment grants as
`restore:enlistment:<agentId>`; no source grant id appears among them, and the destination holds
no sharing grant at all. The destination's only workspace membership is the importer, as owner.

### E7, the residency classification and the actual stores

This is the sharpest claim in the file, and it is a census rather than a sample. The app schema has
57 tables. 46 of them carry a `workspace_id` column; 11 do not.

For the restored workspace, the file counts the rows of every one of the 46 workspace-scoped tables.
Exactly 18 of them hold a row:

```
agents                    channel_participants    channels                 content_refs
group_admissions          group_audience_grants   group_enlistment_grants   message_mentions
messages                  project_members         projects                 task_dependencies
task_execution_attempts   tasks                   workspace_event_dispatches
workspace_event_sequences workspace_events        workspace_memberships
```

The other 28 hold zero rows for that workspace: `addressed_agent_turns`, `artifacts`,
`authorization_audit_records`, `channel_read_states`, `command_outbox`, `content_replicas`,
`coordination_plan_revisions`, `coordination_plans`, `group_sharing_grants`, `lead_turn_intents`,
`legacy_audience_quarantine`, `management_authority_consumptions`, `message_artifact_references`,
`retention_cleanup_receipts`, `retention_deletion_authorizations`,
`retention_deletion_dispatches`, `retention_holds`, `runtime_node_challenges`,
`runtime_node_delivery_requests`, `runtime_node_exchange_credentials`, `runtime_nodes`,
`sim_launch_codes`, `sim_sessions`, `task_mutations`, `task_submissions`, `thread_read_states`,
`workspace_deletions`, `workspace_invitations`.

The counts of the 18 are also tied to the bundle: messages, channels, content refs, projects,
tasks, task dependencies, execution attempts, agents, project members, message mentions, channel
participants, group admissions, group audience grants and group enlistment grants each hold
exactly as many rows as the bundle carries records for. The three group tables and the four
workspace-event tables are the destination's own: they are what the importer writes for itself
(the importer's membership, its freshly issued grants and admissions, and its own
`workspace.created` event), not the source's rows carried over.

The 11 tables with no `workspace_id` column are counted without a filter. `workspaces` holds
exactly the one restored workspace, `users` holds exactly the two identities the destination
provisioned, and the other nine (`artifact_reference_grants`, `auth_identities`,
`coordination_plan_citations`, `desktop_authorization_codes`, `desktop_sessions`, `event_inbox`,
`lead_turn_runtime`, `runtime_node_keys`, `temporary_user_sessions`) hold zero rows.

That is the residency classification, stated as the actual stores rather than as a table-to-class
mapping. The exhaustive table-to-class mapping stays where it belongs, in
`packages/db/tests/unit/portable-export-classification.test.ts`, which asserts that every app
table is either carried by the export or named in the version-1 ledger. This file adds the
round-trip half: what a restored workspace actually occupies.

### E8, offline and unavailable content, stated honestly

Four content references travel as metadata only. A body that is offline in the source's local
authority travels as `bodyState: 'local_authority'` and arrives as `availability: 'missing'`; a
body the local authority no longer holds travels as `bodyState: 'deleted'` and arrives as
`availability: 'deleted'`. The `storagePolicy` stays `local_authority` and the
`synchronizationPolicy` is never upgraded: an `agent_hq_e2ee_sync` reference stays
`agent_hq_e2ee_sync` and a `local_only` reference stays `local_only`. No body, and no replica
row, reaches the destination.

Every withheld external domain is reported: `artifact_bytes_and_locations`,
`control_plane_identifiers`, `e2e_ciphertext_replicas`, `remote_content_envelopes` and
`runtime_execution_state`, each with `status: 'unavailable'`, its authority and its treatment,
and each named by the ledger the bundle carries.

### E9 and E10, refusals

Every refusal case is posted to a destination that does not hold the workspace, so a refusal is
shown to happen before any write, and the destination is then shown to be empty.

Malicious manifests: an unknown top-level field, a wrong format version, an extra ledger class,
an unknown field inside a record, a tampered body, and a document carrying an own `__proto__`
property. The first four are `invalid_document` with the expected issue code; the tampered body is
`digest_mismatch`; the `__proto__` document is refused and `Object.prototype` is unchanged
afterwards. A refusal names the offending path and never the value it found.

Ordering and collision errors: a duplicated message, a `channelOrder` gap, a duplicated channel, a
content reference that resolves to nothing, a task that depends on itself, and a channel run that
is broken across the list. Each is `invalid_document` with `duplicate`, `invariant` or `closure`.

A forged `exportedBy` is accepted as data and ignored as authority: the importer becomes the
owner, and the bundle's claim about another user transfers nothing.

### E11, the canaries

The secret canaries are asserted to be present in the source first, so their absence elsewhere is
a real exclusion and not an absence that was never there. The invitation's raw token is never
stored: its digest is, and the digest is the canary. The private plaintext canaries are present in
the owner's bundle and in the owner's destination, absent from the outsider's bundle, and absent
from the outsider's destination, whose only workspace membership is the outsider, as owner.

### E12, the order across the source, the document and the restore

The order a conversation is read in is compared in three places at once, for every channel the
owner may read: the canonical reader's order in the source, the order the document lists, and the
canonical reader's order in the restored workspace. The three sequences must be the same list of
record ids, and the document's own `channelOrder` must be the one-based position of each record in
that list. A document that listed the right records in a different order, or a restore that
reordered them, fails here.

### E13, the authorized content and its provenance

Every carried record is compared with the source row it came from, field by field: the author, the
created, updated, edited and removed times, the version, and the body of each message; the content
type, digest, sensitivity, key version, schema version, storage policy, synchronization policy,
revision and body state of each content reference; the title, kind, priority, lifecycle state,
creator, version, creation time, objective and objective reference of each task; the name, profile
pins, profile state and lead flag of each Agent; and the name, icon, visibility, lifecycle state,
sort order and source kind of each project. Nothing in the document is invented and nothing is
altered.

Two records the workspace holds are deliberately **not** carried, and the file says so rather than
asserting them into the document:

- a **job publication** is withheld by the readers that decide what the requester may read, so it
  is absent from the document, and the system sender's stored identifier — an encoded binding of the
  acting user, the job and its workspace — travels nowhere;
- a **tombstone** is carried as a tombstone with the time of its removal, and the removed text does
  not travel with it.

### E14, the body states, and what a reader cannot know

Four references cover the four states the local authority can report, and the file states exactly
what the document can and cannot say about them:

| Source state                                   | Document          | Restored workspace |
| ---------------------------------------------- | ----------------- | ------------------ |
| the authority holds the body                   | `local_authority` | `missing`          |
| the authority holds it but cannot serve it now | `local_authority` | `missing`          |
| the authority does not hold it                 | `local_authority` | `missing`          |
| the authority removed it                       | `deleted`         | `deleted`          |

The first three are indistinguishable in the document, and that is the honest limit of the format:
`bodyState` says where a body lives, not whether it is servable now, and the body never travels, so
the destination reports every body that was not removed as missing. The removal time is kept for a
removed body and absent for the others, and the storage and synchronization policies are never
upgraded.

The fourth case is a reference the reader may not know about: a task objective in the members-only
project is present in the owner's document and absent from the outsider's, together with the task
itself. The document never names a record the reader may not read, and the file asserts the
outsider's document contains neither the task nor its reference.

## What this file does not prove

The residual native and real-store gates, stated as gates rather than as failures:

- **The artifact store (#86).** No object store was configured, contacted or read. What is proved is
  that no artifact byte, locator, provenance or reference crosses the bundle or reaches the
  destination, and that the withheld domain is named. The artifact store's own residency is
  unproved, and #86 owns it.
- **The replica store (#193).** The replica ciphertext and nonce never travel and no replica row is
  written. No replica storage was read, no content key and no ContentSyncDevice key were involved,
  and native synchronization stays out of scope by the task's boundary and by the ledger.
- **Native runtime state.** No native session, checkpoint, runtime node binding or execution
  reference was created, executed or read. The exported `executionAttempts` family was populated by
  inserting one cloud-location attempt row directly, because no public API records one; that is a
  fixture choice, stated here, and it exercises the mapper and the importer, not a runtime.
- **The local authority.** A content ref's body was never in the database, so nothing could be read
  from a local authority. What is proved is the metadata contract: the body does not travel and the
  destination says `missing` or `deleted`.
- **Logs, inference and external tools.** The destination logs its own `workspace.created` event
  and the source's event log is not restored. Nothing in this file sends workspace content to a
  model or a tool, and the product's log pipeline, inference path and external tools are not
  checked here.
- **Mid-export revocation.** The route does not expose the export's test seam, and a revocation
  committed between two of the export's own checks is the merged matrix's subject
  (`portable-export-revocation-matrix.test.ts`, `portable-export-midstream-revocation.test.ts`).
  What is proved here is revocation _between_ requests: a revoked group grant and a removed
  membership.
- **The authenticated request path.** The file drives the production response helpers with an
  injected principal, the same seam the other route-flow files use. The real
  `resolveWorkspacePrincipal`, the desktop-session branch and the origin guard stay with
  `apps/web/test/integration/portable-export-authenticated-path.test.ts` (merged #1372).
- **The Cloudflare Worker runtime.** No Worker was deployed, and no CDN or proxy layer was crossed.

## Implementation gaps outside this path boundary

Identified here, not fixed here. Each names the path that owns it.

1. **A bundle cannot say that an artifact reference existed.** The version-1 ledger names the class
   `artifact_bytes_and_locations` as `deferred` and names classes, never counts, so a reader of a
   bundle cannot tell that a message carried an artifact reference which did not travel. The
   behaviour is the documented one (`packages/types/src/portable-export.ts`), and a per-record
   marker would be a format change plus a #86 redaction contract. Owned by #86 and the format.

2. **The offline state of a body is stated per reference, not per source.** `bodyState` says the
   body lives in the local authority or is gone. It cannot distinguish "the body was offline in the
   source" from "the body was available in the source", because the body never travels. The
   `local_authority_bodies` class is `metadata_only`, which is the current contract. A change would
   be a format change in `packages/types/src/portable-export.ts`.

3. **`exportedBy` is outside the content digest.** The digest covers `content` only, so a bundle's
   exporter can be edited without invalidating the document. The importer ignores the field for
   authority (E10 proves the importer still becomes the owner), but any consumer that reads
   `exportedBy` as a fact would be reading an unauthenticated field. This is the format's stated
   design in `packages/types/src/portable-export.ts`, and changing it is a format decision.

4. **A restored group's grant identity is minted, not carried.** The import issues
   `restore:<kind>:<id>` grants from the restored participants, so a bundle cannot be re-verified
   against the source's authority and a later roster change produces different ids. That is the
   `authority_grants` exclusion working as designed; the grant store that owns those rows is
   `packages/db/src/group-participation-store.ts`, which is a shared group path and outside this
   boundary.

5. **The export's "order" is a statement about the visible subset.** A channel of an archived
   project, or of a project the requester cannot read, is absent from the bundle, so the ordering
   guarantee covers what the requester may read and not the workspace's whole history. The
   exclusion is the contract's (`archived_projects`, `archived_channels`, `audience_withheld`).

6. **Residency outside the product database is unproved in full.** This file proves the product
   database's stores and no other store. The remaining stores are listed above as gates.

## Commands and exit codes

Environment: bun 1.4.2, Docker 29.9.1, `postgres:18-alpine` at the digest the repository pins
(`public.ecr.aws/docker/library/postgres:18-alpine@sha256:d3e1620b…`). The source database is an
isolated disposable instance of this lane on `127.0.0.1:55439`, created with `docker run` from the
same pinned image and the repository's own `infra/postgres/init/001-roles.sql`, so it carries the
repository's own role boundary (`agent_hq_local_app` / `agent_hq_local_migration` /
`agent_hq_local_admin`), migrated with the repository's own migrations (61 applied) and verified by
`bun scripts/database-health.mjs`. It was started under its own container name and loopback port
rather than through the shared Compose project, so it touched no other lane's database and no other
lane's container. The throwaway provisioning instance that carries the disposable destination
databases is started and removed by the repository's own
`scripts/run-with-capture-provisioning.mjs`.

All commands below were run from the worktree root with:

```
DATABASE_URL=postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55439/agent_hq?sslmode=disable
DATABASE_MIGRATION_URL=postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55439/agent_hq?sslmode=disable
```

| #   | Command                                                                                                                                                                                                                                                             | Exit | Result                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `bun scripts/run-with-capture-provisioning.mjs -- bun --conditions=react-server test --preload ./scripts/test-solid-transform.ts --timeout 30000 apps/web/test/integration/portable-export-residual-residency.test.ts`                                              | 0    | 19 pass, 0 fail, 638 assertions                                                                                                                                                                                                                                                                                                                                                                     |
| C2  | `bun scripts/run-with-capture-provisioning.mjs -- bun test --parallel --conditions=react-server --preload ./scripts/test-solid-transform.ts --timeout 30000` over the residual file and the five merged portable route-flow files                                   | 0    | 77 pass, 0 fail, 1016 assertions across 6 files. The first measurement of this row, 74 pass and 724 assertions, predated the residual file's second round; the continuation re-measured it against the file the branch now carries (Q7)                                                                                                                                                             |
| C3  | `bun scripts/run-with-capture-provisioning.mjs -- bun --conditions=react-server test --timeout 30000` over the six `packages/db/tests/integration/portable-*.test.ts` files                                                                                         | 0    | 61 pass, 0 fail, 334 assertions across 6 files. The first measurement of this row, 60 pass and 325 assertions, was taken against the pre-repair channel-bounds file; the continuation re-measured it against the repaired file and against the pre-repair file, to show which is which (Q6, Q8)                                                                                                     |
| C4  | `bun test` over the four portable unit files and `packages/types/tests/portable-export.test.ts`                                                                                                                                                                     | 0    | 48 pass, 0 fail, 257 assertions across 5 files                                                                                                                                                                                                                                                                                                                                                      |
| C5  | `bun scripts/database-health.mjs`                                                                                                                                                                                                                                   | 0    | `Database health check passed (database=agent_hq, runtimeRole=agent_hq_local_app, migrationRole=agent_hq_local_migration)`                                                                                                                                                                                                                                                                          |
| C6  | `bun run --cwd packages/db db:migrate`                                                                                                                                                                                                                              | 0    | `Migration verification passed (61 applied migration(s))`                                                                                                                                                                                                                                                                                                                                           |
| C7  | `bunx tsc -p packages/db/tsconfig.json --noEmit`                                                                                                                                                                                                                    | 0    | no diagnostics                                                                                                                                                                                                                                                                                                                                                                                      |
| C8  | `bunx tsc -p packages/types/tsconfig.json --noEmit`                                                                                                                                                                                                                 | 0    | no diagnostics                                                                                                                                                                                                                                                                                                                                                                                      |
| C9  | `bunx tsc --ignoreConfig --noEmit --strict --target ES2023 --lib ES2023,DOM --module ESNext --moduleResolution bundler --skipLibCheck --types bun-types --esModuleInterop --resolveJsonModule apps/web/test/integration/portable-export-residual-residency.test.ts` | 0    | no diagnostics                                                                                                                                                                                                                                                                                                                                                                                      |
| C10 | `bunx oxlint --deny-warnings apps/web/test/integration/portable-export-residual-residency.test.ts`                                                                                                                                                                  | 0    | no findings                                                                                                                                                                                                                                                                                                                                                                                         |
| C11 | `bunx oxfmt --check apps/web/test/integration/portable-export-residual-residency.test.ts`                                                                                                                                                                           | 0    | `All matched files use the correct format.`                                                                                                                                                                                                                                                                                                                                                         |
| C12 | `bun test scripts/integration-inventory.test.ts`                                                                                                                                                                                                                    | 0    | 20 pass, 0 fail (the new route-flow file is discovered by the lane's own inventory)                                                                                                                                                                                                                                                                                                                 |
| C13 | `bun test scripts/capture-provisioning.test.ts scripts/run-with-capture-provisioning.test.ts`                                                                                                                                                                       | 0    | 53 pass, 0 fail                                                                                                                                                                                                                                                                                                                                                                                     |
| C14 | `bun scripts/run-with-capture-provisioning.mjs -- bun test --parallel --conditions=react-server --preload ./scripts/test-solid-transform.ts --timeout 30000` over every file in `apps/web/test/integration`                                                         | 0    | 347 pass, 0 fail, 8291 assertions across 33 files                                                                                                                                                                                                                                                                                                                                                   |
| C15 | `git fetch origin main`                                                                                                                                                                                                                                             | 0    | `origin/main` is `73e444f59eb3526f5b18f985c2b2f1f9ae302d5a`, and the base commit is an ancestor of it. The continuation re-fetched it: `origin/main` is now `f3cf912d093fbf163a107c3b197e237c81f2c2bb`, and the base commit is still an ancestor of it, so the branch is still behind main rather than diverged from it; the three paths are still untouched by it (Q13)                            |
| C16 | `git fetch origin "pull/1549/head:refs/remotes/origin/pr-1549"`                                                                                                                                                                                                     | 0    | the pull request's head is `1dc887d74aacc52ff4237a9025283535f40ceb52`, this branch's own commit. The continuation re-fetched it: the pull request's head is now `7afd68613d4e3d70401c2e74a144ed8ce97636ff`, which is this branch's own head, so the branch's four commits are on the pull request (Q13)                                                                                             |
| C17 | the residual acceptance file on a fresh task-owned source database                                                                                                                                                                                                  | 0    | 19 pass, 0 fail, 638 assertions                                                                                                                                                                                                                                                                                                                                                                     |
| C18 | the five other `packages/db` portable integration files on the same task-owned database                                                                                                                                                                             | 0    | 50 pass, 0 fail, 233 assertions                                                                                                                                                                                                                                                                                                                                                                     |
| C19 | `packages/db/tests/integration/portable-export-channel-bounds.test.ts` on the same task-owned database                                                                                                                                                              | 0    | 11 pass, 0 fail, 101 assertions                                                                                                                                                                                                                                                                                                                                                                     |
| C20 | `bun run --cwd apps/web cf-typegen` in this worktree                                                                                                                                                                                                                | 0    | the pinned generator ran, but the body it wrote was the network's parked page, 44,884 bytes; it was discarded and never used                                                                                                                                                                                                                                                                        |
| C21 | the Miniflare dispatch probes (a constant worker, `dummy.com`, `example.com`, `localhost`, and the same dispatch with the egress blocked)                                                                                                                           | 0    | every dispatch left the machine, so the parked page is the network's answer                                                                                                                                                                                                                                                                                                                         |
| C22 | `bun run typecheck` with the verified official artifact in this worktree                                                                                                                                                                                            | 0    | `No type errors in 325 files`                                                                                                                                                                                                                                                                                                                                                                       |
| C23 | the repository's pre-commit gate (format check, then type check)                                                                                                                                                                                                    | 0    | the format check passed and the type check passed                                                                                                                                                                                                                                                                                                                                                   |
| C24 | `bun check -p tsconfig.json` at the repository root                                                                                                                                                                                                                 | 1    | not the repository's gate and not green on this base: 12 distinct entries over about 500 files, dominated by `TS2550 toSorted` because the root config's `lib` is ES2022 while every package config uses ES2023. This branch's two test files appear in that summary with the same per-file counts as the pre-existing merged portable files (13 each), so nothing here is specific to this change. |

C2's file list is `portable-export-residual-residency.test.ts`,
`portable-residency-e2e.test.ts`, `portable-workspace-clean-restore.test.ts`,
`portable-workspace-routes.test.ts`, `portable-export-midstream-revocation.test.ts` and
`portable-export-revocation-matrix.test.ts`. C3's file list is `portable-export.test.ts`,
`portable-export-channel-bounds.test.ts`, `portable-export-isolation.test.ts`,
`portable-import-refusal.test.ts`, `portable-restore-clean.test.ts` and
`portable-restore-order.test.ts`.

C14 is the lane's whole route flow, so the new file is proven to coexist with every other
route-flow file. Two things had to be true for it, and both are recorded here rather than
smoothed over:

- The lane builds `packages/api-client` and `packages/state` before the route flow, because the
  route files import their compiled entries. A run that skips those builds fails with
  `Cannot find module '@adea-ai/api-client'` in four files that have nothing to do with this
  change. The first full-lane run here reported exactly that, plus three timeouts; the same files
  pass on a re-run with the two packages built, and pass in isolation.
- The three disposable destinations are created when the first test needs them, not all in
  `beforeAll`, because each one costs a full migration of the repository's schema and the lane
  runs its files in parallel against one database instance. Concentrating all three in `beforeAll`
  starved a neighbouring file: `job-outbound-routes.test.ts` hit the lane's 30-second per-test
  ceiling under the heavier load and failed with a timeout, not an assertion. With the
  destinations created lazily, the whole lane passes (C14), and the same lane without this file
  passes too, so the two are comparable.

One earlier run of the scripts unit lane (C13) reported eight failures and two errors. Every one of
them was `toomanyrequests: Data limit exceeded` from the shared image registry, or a timeout
waiting for it, while the capture helper pulled its fallback image. Those are environmental: the
same files pass in another clean worktree of this fleet and pass here on a re-run, and none of them
touches the code under test. They are recorded rather than hidden.

## Mutation checks

Each mutation changes one compiled artifact of the merged implementation, runs the residual file
and is then reverted by rebuilding `packages/db` from source. The mutations were applied to the
git-ignored build output under `packages/db/dist`, never to a tracked file: the worktree's tracked
state stayed clean throughout, and `git status` after the last rebuild shows only the new test
file. The reason is the path boundary: the implementation files are not this worker's to edit, so
the sensitivity of the new file was measured against the compiled output instead of the source.

| Mutation | Change                                                                        | Result                                                                                                                                                                                      |
| -------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1       | the mapper sorts messages by id instead of by the source sequence             | exit 1; `the bundle lists the messages in the order the canonical reader serves them` and `the restore reproduces the order, the links and the digest of the bundle` fail (14 pass, 2 fail) |
| M2       | the importer mints `audience:<userId>` instead of `restore:audience:<userId>` | exit 1; `the source grants are never transplanted; the restore issues its own` fails (15 pass, 1 fail)                                                                                      |
| M3       | the importer restores a deleted content ref with `availability: 'available'`  | exit 1; the restore is refused by the database check `content_refs_deletion_consistent`, so every test that needs the restored destination fails (7 pass, 9 fail)                           |
| M4       | the mapper reports every content ref's `bodyState` as `local_authority`       | exit 1; `the withheld external domains are reported unavailable and the offline bodies are stated honestly` fails (15 pass, 1 fail)                                                         |
| M5       | the project visibility predicate returns no condition                         | exit 1; the export reads a channel the canonical reader refuses (`Channel unavailable`), so the round trip cannot be built (0 pass, 1 fail)                                                 |

M5 is worth reading closely: removing the export's own project-visibility predicate did not leak a
private record, because the canonical reader is a second, independent gate. It broke the export
instead. That is the audience claim's shape, and it is recorded here as an observation about the
merged implementation rather than as a defect.

The refusal cases in E9 are a second kind of negative control that needs no mutation: they are
mutations of a real bundle, and the contract must refuse each one.

## The lane collision at the portable-export channel bounds

The Fleet 3 shared index records a lane failure in a neighbouring file, and the root cleared that
file for this worker for diagnosis and an attributable fixture-isolation repair only:

```
packages/db/tests/integration/portable-export-channel-bounds.test.ts ::
  mid-export project grants cannot expand channel or participant reads past the snapshot
PostgreSQL 23505 duplicate channels_pkey for id ffffffff-ffff-4fff-8fff-ffffffffffff
```

The failing insert is in the case at line 583, and the id it inserts is the hard-coded constant at
line 615. This section records the diagnosis and the repair; it is test-only and changes no export
behaviour.

### Attribution: the fixture, not the product

`channels.id` is a **global** primary key, not a per-workspace one. The primary key is correct and
must not be weakened: it is what stops two workspaces from claiming the same channel identity. The
defect is on the fixture side, and it is a fixture-isolation defect of exactly one kind — a fixed
identifier reused across runs.

Static inspection of the file finds three families of channel rows whose primary key is **not**
scoped to the run, while every other row in the same file uses `randomUUID()`:

| Line | Identifier                             | Rows                                            |
| ---- | -------------------------------------- | ----------------------------------------------- |
| 615  | `ffffffff-ffff-4fff-8fff-ffffffffffff` | the late-project channel of the mid-export case |
| 750  | `00000000-0000-4000-8000-${index + 1}` | the heavy visible scale range, up to 157 rows   |
| 937  | `00000000-0000-4000-8000-000000000000` | the participant-boundary channel                |

The file's own cleanup deletes channels **by `workspace_id`** in `afterAll`, so a run that completes
leaves nothing behind. The recorded failure therefore proves that a row carrying one of those
primary keys was present in that database at the moment the insert ran. Two conditions produce
that, and both are fixture-isolation conditions rather than product defects:

1. a run of this file that was interrupted before its cleanup, whose row outlived it; and
2. two runs of this file against one shared lane database, which the fixed identifier makes
   collide even when both runs would clean up.

The lane that recorded the failure ran `bun run test:integration`, whose default target is the
shared Compose instance, so a concurrent run of the same file against that database is available as
an explanation; the index's own receipt does not say which of the two conditions occurred, and this
file does not claim to know. What is established is the mechanism: a fixed global primary key in a
fixture.

### The repair (test fixture only)

Every channel fixture id in the file is now scoped to the run marker `run` that the file already
generates, and each fixture keeps the position its identifier always had:

| Identifier                   | Now                                                                   | Position                               |
| ---------------------------- | --------------------------------------------------------------------- | -------------------------------------- |
| late-project channel         | `ffffffff-ffff-4fff-8fff-${run}`                                      | the highest identifier of the space    |
| participant-boundary channel | `00000000-4000-8000-0000-${run}`                                      | the lowest identifier of the space     |
| heavy visible scale row _i_  | `00000000-4${(i + 1).toString(16).padStart(3, '0')}-8000-0000-${run}` | the lowest identifiers, in index order |

The **position** is not cosmetic, and the first attempt at this repair got it wrong, which the
bounded reproduction caught. The channel page cursor is the channel id and the participant reads are
ordered by channel id, so the _order_ of these identifiers decides three observable things: which
channels a reader meets first, where the 10,000-row participant bound splits a batch (at 156
channels, 156 x 64 participants), and which page first exceeds that bound. Moving the heavy-scale
family to the high end of the identifier space made the export meet the participant-bound channel
late, and two existing assertions failed with it. The repair therefore keeps the low family low
and the late-project channel high, and replaces only the constant part with the run marker.

The two families cannot collide with each other, and none of them can equal an identifier an
earlier or concurrent run used: the run marker is 48 bits of `randomBytes`, carried whole in the
identifier, and the index separates the fixtures of one run. The product's uniqueness and
authorization checks are untouched: the fixture inserts still use plain inserts, and a genuine
collision would still fail.

### The deterministic regression

The repaired file carries one new case, placed immediately before the mid-export case, that
reproduces the historical condition inside the lane instead of hoping for it:

1. it plants the two legacy identifiers as leftover rows — the exact primary keys from the
   recorded failure — in the lane database, tolerating a leftover that is already there, because
   "already there" is the condition under test;
2. it asserts that no identifier this run creates is one of those fixed identifiers, and that the
   run's three identifiers are distinct from each other;
3. it then creates the run's own fixtures **while the leftovers are present**, and asserts the rows
   exist.

With the pre-repair fixture the case fails on the insert with `23505 duplicate channels_pkey`, the
recorded error. With the repair it passes. The leftover rows are participant-only channels with no
participants: the collision is on the primary key alone, and such a row is invisible to every
other assertion in the file, so the leftovers cannot perturb the cases that follow.

### The bounded reproduction, and its result

The reproduction ran on this worker's own disposable PostgreSQL instance, on two databases created
there with the repository's own migrations, and it used the repository's own test invocation
(`bun --conditions=react-server test --timeout 30000`, the local-target timeout the integration
lane uses; no timeout was raised).

The `f3w4_channel_bounds_repro` database carries the two leftover rows with the legacy primary
keys, planted the way an interrupted earlier run would have left them, in a workspace of their own.

| Step | Fixture              | Condition                          | Exit | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | -------------------- | ---------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | pristine, pre-repair | the seeded legacy rows present     | 1    | 8 pass, 2 fail. `mid-export project grants cannot expand channel or participant reads past the snapshot` fails with `PostgresError: duplicate key value violates unique constraint "channels_pkey"`, code `23505`, on the insert of `ffffffff-ffff-4fff-8fff-ffffffffffff` — the recorded failure, byte for byte. `materializes exactly 10,000 participants and refuses 10,001 before detail transfer` fails on `00000000-0000-4000-8000-000000000000`: the defect is a family of fixed identifiers, and the recorded lane failure was only the first of them. |
| B    | repaired             | the same seeded rows still present | 0    | 11 pass, 0 fail, 101 assertions, and **no** duplicate-key error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| C    | repaired, repeated   | the same seeded rows still present | 0    | 11 pass, 0 fail, 101 assertions. Two patched runs in a row against one database both succeed, which is the repeat-run isolation the repair is for.                                                                                                                                                                                                                                                                                                                                                                                                             |

Two controls on a second, clean database isolate the repair from the leftovers:

| Control | Fixture              | Condition      | Exit | Result                                                                                                   |
| ------- | -------------------- | -------------- | ---- | -------------------------------------------------------------------------------------------------------- |
| C0      | pristine, pre-repair | clean database | 0    | 10 pass, 0 fail — the base file is green, so the step-A failure is the seeded condition and not the file |
| C3      | repaired             | clean database | 0    | 11 pass, 0 fail, 101 assertions                                                                          |

The first version of the repair failed the C3 control on a clean database: it scoped the identifiers
to the run but moved the heavy-scale family to the high end of the identifier space, which changed
two order-sensitive assertions of the base file (the participant batch no longer split at 156
channels, and the export met the participant-bound channel on its last page instead of its first).
The repair was corrected to preserve the identifier positions, and the table above records the
corrected result. That correction is why the identifier _position_ is now part of the recorded
contract of this fixture.

**Attribution.** The evidence supports the fixture attribution and nothing else. The pristine
fixture fails on exactly the recorded primary key, the repaired fixture passes with that same row
still in the database, and the product's `channels_pkey` is correct and untouched. This file does
**not** claim to know which of the two conditions produced the row in the lane that recorded the
failure — an interrupted run, or a concurrent run against one shared lane database. The shared index
receipt does not say, and this file does not guess: the repair removes the dependence on which one
it was.

### The other checks in this phase, with raw exits

| Command                                                                                                                                     | Exit | Result                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker inspect f3w4-postgres-26493c8c --format …`                                                                                          | 0    | the task-owned container: the repository-pinned postgres digest, `127.0.0.1:55439` -> 5432, running since `2026-10-21T09:02:22Z` — the identity in this worker's own creation receipt                                                                                   |
| `docker exec f3w4-postgres-26493c8c psql … -d f3w4_channel_bounds_repro`                                                                    | 0    | both seeded legacy primary keys present, 61 migrations, one workspace, one user                                                                                                                                                                                         |
| `bunx oxfmt --check packages/db/tests/integration/portable-export-channel-bounds.test.ts`                                                   | 0    | `All matched files use the correct format.`                                                                                                                                                                                                                             |
| `bunx oxlint --deny-warnings packages/db/tests/integration/portable-export-channel-bounds.test.ts`                                          | 0    | no findings                                                                                                                                                                                                                                                             |
| `bunx tsc --ignoreConfig --noEmit …` on the pristine file and on the repaired file                                                          | 1    | 34 diagnostics each, byte-identical after normalizing line and column: the repair adds no type diagnostic and changes none. The file is outside the repository's type gate, which covers `packages/db/src`, and the 34 diagnostics are pre-existing on the base commit. |
| `bun run --cwd packages/db db:migrate` against both reproduction databases                                                                  | 0    | `Migration verification passed (61 applied migration(s))`                                                                                                                                                                                                               |
| the leftover-row plant                                                                                                                      | 0    | `INSERT 0 1`, `INSERT 0 1`, `INSERT 0 2`                                                                                                                                                                                                                                |
| the repaired file on the clean database, step C3 above                                                                                      | 0    | 11 pass, 0 fail, 101 assertions                                                                                                                                                                                                                                         |
| the residual acceptance file, `apps/web/test/integration/portable-export-residual-residency.test.ts`, on a fresh task-owned source database | 0    | 16 pass, 0 fail, 346 assertions — the residual file as it stood in this phase. The file the branch finally carries is 19 tests and 638 assertions; see C1, C17 and Q1                                                                                                   |
| the five other `packages/db` portable integration files on the same task-owned database                                                     | 0    | 50 pass, 0 fail, 233 assertions                                                                                                                                                                                                                                         |

No production database, no other lane's database and no other lane's container was read or
written. The task-owned disposable instance and its two databases were removed after the evidence
above was captured, and nothing else was stopped, removed or pruned.

## The continuation: a second qualification round

The continuation re-qualified the two fixtures this branch owns, on a second task-owned disposable
instance, and did not rebuild the merged implementation. It ran the focused suites first and did not
start a workspace-wide aggregate.

**The disposable instance.** `f3w4-qual-postgres-1792606402`, from the repository-pinned image
`public.ecr.aws/docker/library/postgres:18-alpine@sha256:d3e1620b…`, bound to `127.0.0.1:55441` ->
5432, started with the repository's own `infra/postgres/init/001-roles.sql`, so it carries the
repository's own role boundary (`agent_hq_local_app` / `agent_hq_local_migration` /
`agent_hq_local_admin`). It is not the shared Compose instance and it is not any other lane's
container: it was created under its own name on its own loopback port, and the container, its volume
and its network were removed by name when the round ended. It carried two databases, `agent_hq` and
`f3w4_qual_repro`, both migrated with the repository's own migrations (61 applied) and both verified
by `bun scripts/database-health.mjs`.

The `f3w4_qual_repro` database carried the seeded condition of the bounded reproduction: the two
legacy channel primary keys, in a workspace of their own so that the file's own cleanup — which
deletes by its own `workspace_id` — could not remove them. The seed is the same condition the first
phase planted, written independently of it, and the rows are still there after the round: a leftover
that the repaired fixture has to survive.

**The seed and the repeat.** The qualification asked two questions the first phase did not: does the
repaired fixture survive a database that already carries another run's leftovers, and does it survive
being run again against the same database. The answers are in Q2, Q3, Q9, Q10 and Q11 below: the
repaired fixture passes on the seeded database with the leftovers present, passes again on a second
run against the same database, and the leftovers are still present afterwards. The residual
acceptance file was run twice against the same source database and once against the seeded
database, and it left no residue of its own: the source database held zero workspaces, users,
channels, messages and tasks after each run, and no scratch database survived.

**The commands and their exits.** All of them ran from the worktree root with
`DATABASE_URL=postgresql://agent_hq_local_app:…@127.0.0.1:55441/…` and
`DATABASE_MIGRATION_URL=postgresql://agent_hq_local_migration:…@127.0.0.1:55441/…`, against the
task-owned instance only.

| #   | Command                                                                                                   | Exit | Result                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | the residual acceptance file on a fresh task-owned source database                                        | 0    | 19 pass, 0 fail, 638 assertions                                                                                                                                                                                                                                                                            |
| Q2  | the residual acceptance file, repeated, on the same source database                                       | 0    | 19 pass, 0 fail, 638 assertions; the source database held zero workspaces, users, channels, messages and tasks afterwards, and no scratch database survived                                                                                                                                                |
| Q3  | the residual acceptance file on the seeded database, with the two legacy primary keys still present       | 0    | 19 pass, 0 fail, 638 assertions; both seeded rows still present and untouched                                                                                                                                                                                                                              |
| Q4  | the repaired channel-bounds file on a clean task-owned database                                           | 0    | 11 pass, 0 fail, 101 assertions                                                                                                                                                                                                                                                                            |
| Q5  | the five other `packages/db` portable integration files on the same database                              | 0    | 50 pass, 0 fail, 233 assertions                                                                                                                                                                                                                                                                            |
| Q6  | the six `packages/db` portable integration files, with the repaired channel-bounds file                   | 0    | 61 pass, 0 fail, 334 assertions across 6 files                                                                                                                                                                                                                                                             |
| Q7  | the residual file and the five merged portable route-flow files, in parallel                              | 0    | 77 pass, 0 fail, 1016 assertions across 6 files                                                                                                                                                                                                                                                            |
| Q8  | the same six `packages/db` portable integration files, with the **pre-repair** channel-bounds file        | 0    | 60 pass, 0 fail, 325 assertions across 6 files — the first measurement of C3, reproduced                                                                                                                                                                                                                   |
| Q9  | the bounded reproduction, step A: the pre-repair file on the seeded database                              | 1    | 8 pass, 2 fail. `PostgresError: duplicate key value violates unique constraint "channels_pkey"`, code `23505`, on `Key (id)=(ffffffff-ffff-4fff-8fff-ffffffffffff) already exists` and then on `Key (id)=(00000000-0000-4000-8000-000000000000) already exists` — the recorded lane failure, byte for byte |
| Q10 | the bounded reproduction, step B: the repaired file on the seeded database                                | 0    | 11 pass, 0 fail, 101 assertions, and no duplicate-key error                                                                                                                                                                                                                                                |
| Q11 | the bounded reproduction, step C: the repaired file, repeated, on the same seeded database                | 0    | 11 pass, 0 fail, 101 assertions; two patched runs in a row against one database both succeed                                                                                                                                                                                                               |
| Q12 | the control: the pre-repair file on a clean database                                                      | 0    | 10 pass, 0 fail, 92 assertions — the base file is green, so Q9's failure is the seeded condition and not the file                                                                                                                                                                                          |
| Q13 | the read-only `git fetch origin main` and `git fetch origin "pull/1549/head:refs/remotes/origin/pr-1549"` | 0    | `origin/main` is `f3cf912d093fbf163a107c3b197e237c81f2c2bb`, eleven commits ahead of the base, and the three paths are untouched by it; the pull request's head is `7afd68613d4e3d70401c2e74a144ed8ce97636ff`, this branch's own head                                                                      |

Q9's failure is the attribution, again: the pre-repair fixture fails on exactly the recorded primary
key, the repaired fixture passes with that same row still in the database, and the product's
`channels_pkey` is correct and untouched. The reproduction is the same on a second instance, on a
second pair of databases, with a seed written independently of the first phase's.

**The checks that were re-run unchanged.** The portable unit files and `packages/types`' portable
export test (48 pass, 0 fail, 257 assertions across 5 files), `bun scripts/database-health.mjs`,
`bun run --cwd packages/db db:migrate` against both databases, `bunx tsc -p packages/db/tsconfig.json
--noEmit`, `bunx tsc -p packages/types/tsconfig.json --noEmit`, the standalone `tsc --ignoreConfig`
check of the residual file, `bunx oxlint --deny-warnings` and `bunx oxfmt --check` over both files,
`bun test scripts/integration-inventory.test.ts` (20 pass) and `bun test scripts/capture-provisioning.test.ts
scripts/run-with-capture-provisioning.test.ts` (53 pass). The last of those printed the same
environmental `toomanyrequests: Data limit exceeded` messages from the shared image registry that
the first phase recorded; they are the registry's answer, not a failure of the code under test.

**What the continuation did not do, and why.**

- It did not re-run the whole route-flow lane (C14, 33 files) or any workspace-wide aggregate. The
  machine's load average was between 8 and 14 on twelve cores while the round ran, and the round
  was told not to start one. The six portable route-flow files (Q7) and the six `packages/db`
  portable files (Q6) are the focused groups that cover this change, and both are green.
- It did not re-run the Miniflare dispatch probes (C20, C21) and did not regenerate
  `apps/web/cloudflare-env.d.ts`. That path is a gitignored generated artifact, and the verified
  official body is already in this worktree: sha256 `9b5e7188fa64b8807fb0a48873dc0755d0490b71ce6b8598f3b9b79d1718025e`,
  623,606 bytes, carrying the `// Begin runtime types` marker and no HTML. Running the generator
  again in this environment replaces it with the network's parked page, so the file was left alone.
- It did not re-run the broad root `bun check -p tsconfig.json` (C24). That check is not the
  repository's gate, it is not green on this base for pre-existing reasons, and the root TypeScript
  settings are out of scope for this change: the global `lib` is ES2022 while every package
  configuration uses ES2023, and the remedy belongs to a repository-wide decision, not to this
  branch. The two focused type checks above are the ones that cover the three paths.
- It did not re-run the repository's whole type check (C22) and did not re-run the gate's type check
  on its own. The gate is change-aware: it type-checks only when a typed source or a compiler
  configuration is staged, and the continuation stages one Markdown document, so the gate runs the
  format check over that document and skips the type check. The type-check result at C22 and C23
  was measured at the first phase's code state, and the continuation changed no typed file, no
  compiler configuration and no product source, so that result still stands for this branch's code.
  The two focused type checks above cover the three paths directly.
- It did not rebuild the merged implementation, and it did not change any product path. The only
  tracked path this continuation changed is this document.

**Two observations that are not defects, recorded so that they are not rediscovered as ones.**

1. The run-scoped identifier's index is written as three hexadecimal digits, so the family would
   stop being a valid UUID shape if the heavy scale range ever grew past 4,094 channels. The file's
   range is 157, and an overflow would fail loudly as a malformed identifier rather than as a
   silent collision, so the shape is safe as it stands and no change was made.
2. The seeded rows in this round live in a workspace of their own, exactly as in the first phase, so
   the file's own cleanup never removed them and the condition was live for every repetition in
   Q9, Q10 and Q11. That is what makes those three rows a repeat-and-seed proof rather than three
   ordinary runs.

## The pre-commit type check blocker, and what it was

The repository's pre-commit gate runs the project's format check and its type check. The type
check was failing with 1,297 parse errors in one file and the message "Stopped before type checking
325 files". The file was `apps/web/cloudflare-env.d.ts`.

**It is not a source defect.** That path is listed in `.gitignore` and is a _generated_ artifact:
`apps/web` regenerates it with `wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts`
before its own type check. The failure was in the generated body, and none of this branch's three
paths is in the type check's file set: `packages/db` type checks `src` only, `apps/web` excludes
`test`, and this document is not TypeScript. Running the same type check with this branch's three
paths unstaged produced the identical failure, so the change under review cannot cause it.

**The pinned tool and the pinned source.** `wrangler` 4.147.0 and `workerd` 1.20261001.1 are both
pinned by the repository's lockfile and both are installed here. `wrangler types` does not
download the runtime types: it starts a local Miniflare instance on the pinned
`workerd/worker.mjs` — the official RTTI worker — and dispatches
`http://dummy.com/<compatibilityDate><flags>` to it. That worker calls the native `workerd:rtti`
module's `exportTypes(...)` and returns the type definitions. The generated file's own header
records the inputs: the Wrangler configuration hash `a9a4173b…`, `workerd@1.20261001.1`,
compatibility date `2026-08-01`, and the flags
`enable_request_signal,global_fetch_strictly_public,nodejs_compat`.

**What the failure actually was.** In this session the dispatch does not reach the worker: a worker
that returns a constant string is bypassed as well, `http://dummy.com/…` returns dummy.com's
parked-domain page, `https://example.com/…` returns example.com's own 404 page, and with the egress
blocked the same dispatch fails with "Unable to connect". The parked page is therefore the
_network's_ answer, not the runtime's, and it is not the official runtime types: it carries no
`// Begin runtime types` body. It was discarded and never used.

**What was done.** The official artifact for exactly these inputs is verifiable: three independent
worktrees of this fleet hold a byte-identical file (sha256 `9b5e7188…`, 623,606 bytes) whose first
three lines are byte-identical to the ones the pinned tool writes here, which carries the
`// Begin runtime types` marker and no HTML. That artifact was placed in **this** worktree's
generated path only — no other worker's file was touched, and no tracked path changed — and the
pinned tool itself accepted it: the `cf-typegen` step that the type check runs printed "Runtime
types generated." and left the file byte-identical, because the tool reuses an existing body whose
header matches. The type check then passed, with the format check, in the gate itself.

**The remaining prerequisite.** A worktree that has _no_ valid cached artifact still cannot obtain
one in this environment, because the runtime's RTTI request leaves the machine and the egress
answers with a parked page. The prerequisite is that Miniflare's embedded workerd answers the RTTI
request locally — or that egress returns the official workerd runtime types, verified by the
`// Begin runtime types` marker and the `workerd@…` header. Until that holds, a fresh worktree's
first generation is poisoned by the network's answer, and the remedy is to materialise the verified
artifact rather than to run the generator blindly.

## Current main and the pull request

`origin/main` has moved on since the base commit. It is now
`f3cf912d093fbf163a107c3b197e237c81f2c2bb`, eleven commits ahead, and the base commit
`ee31982e70406ab5de447a79603d6545ac11359f` is an ancestor of it, so this branch is behind main
rather than diverged from it. Those eleven commits are the protected Home lifecycle (#1547), the
populated migration rollback outcome (#1545), the runtime connection and profile read models
(#1544), the remote-content return envelopes (#1546), the cross-runtime return vector (#1552), the
workspace reorder conflict fix (#1542), the integration lane's resource ownership and reuse policy
(#1543), the group's bounded revoke and earlier-history grant commands (#1178, #1553), the group's
effective standing read model (#1178, #1554), the `0.100.0` release (#1556) and the native session
family's field-drift cases (#1557).

**None of them touches the three paths of this work.** `git diff` between the base commit and
current main over the three paths is empty, so the merged work on main neither conflicts with this
boundary nor changes the behaviour these proofs observe. The branch is deliberately **not** rebased:
a rebase would rewrite the published head of the pull request and need a force push, which is not
authorized here, and the three paths need no change to sit on the new main.

The pull request is #1549. Its published head is now
`7afd68613d4e3d70401c2e74a144ed8ce97636ff`, which is this branch's own head: the branch's four
commits — the fixture repair, the residual acceptance's first and second rounds, and the type-check
provenance record — are all on the pull request. The read-only fetch in the first phase found the
pull request one commit behind the branch, with that commit unpublished because no authorized
publishing route existed then; the normal publisher has since carried it, and the continuation
re-read the ref to confirm the state rather than repeat the first phase's account of it. The
pull-request ref is read only through a read-only fetch with the credential helper disabled and the
terminal prompt disabled, so no credential is read, created or used; nothing was pushed, and no
issue was closed.

## Boundary compliance

Held and recorded:

- No live export was taken. Every export in this file is taken from a disposable lane database
  through the production response helper.
- No real deletion, no retention path and no cleanup path of the product was exercised. The only
  rows this file removes are its own fixture rows, in its own disposable database, plus the three
  disposable destination databases it created itself, which are dropped by name.
- No W7 path, no #1221 implementation, no #86 provisioning, no #193 native synchronization, no
  shared group or migration file, no UI, no credential and no production, deployment or
  access/security change.
- No shared index was written. `cross-fleet-ownership.json` was read only; the Fleet 3 ledger is
  read only.
- The only tracked paths changed are `apps/web/test/integration/portable-export-residual-residency.test.ts`,
  `docs/evidence/m18-02-2-f3-residual-acceptance.md` and the test-only fixture repair in
  `packages/db/tests/integration/portable-export-channel-bounds.test.ts`.
- No other lane's database, container or file was written. The other lanes' PostgreSQL instances
  and the shared Compose instance were left untouched; the one neighbouring log that was read
  (`/tmp/f3w7-integration-lane.log`) was read only, to attribute the recorded failure.
- The continuation added one more task-owned disposable instance of its own, on its own name and its
  own loopback port, and removed it by name at the end of the round. It read two remote-tracking
  refs, `origin/main` and the pull request's head, through read-only fetches with the credential
  helper disabled and the terminal prompt disabled. It pushed nothing, created no credential, used
  no interactive login, made no unauthenticated `gh` call, marked nothing ready, merged nothing and
  closed no issue.

## Publication

The evidence set is draft-ready: one new test file, this document, and the test-only fixture repair
in `packages/db/tests/integration/portable-export-channel-bounds.test.ts`, on branch
`codex/f3w4-adea-20261021` at base `ee31982e70406ab5de447a79603d6545ac11359f`.

The three paths are committed on this branch, on top of the base commit
`ee31982e70406ab5de447a79603d6545ac11359f`, and the working tree is clean. The pull request is
**#1549**, a draft, with auto-merge off. The repository's own pre-commit gate — the format check and
the type check — passes on this branch, with the type check running over 325 files without an
error.

### The draft packet

| Item           | Value                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request   | #1549, **draft**, auto-merge off, no issue closed                                                                                                                                                  |
| Branch         | `codex/f3w4-adea-20261021`                                                                                                                                                                         |
| Base           | `ee31982e70406ab5de447a79603d6545ac11359f` (an ancestor of current `origin/main`)                                                                                                                  |
| Head           | the commit on this branch, over the three paths below                                                                                                                                              |
| Paths          | `apps/web/test/integration/portable-export-residual-residency.test.ts`, `docs/evidence/m18-02-2-f3-residual-acceptance.md`, `packages/db/tests/integration/portable-export-channel-bounds.test.ts` |
| Body           | this document, verbatim                                                                                                                                                                            |
| Reviewer state | no readiness claimed, no merge, no production action                                                                                                                                               |

The counts this packet quotes are the ones this document records: the residual acceptance file at
**19 tests and 638 assertions**, the repaired channel-bounds file at **11 tests and 101
assertions**, the five neighbouring portable integration files at **50 tests and 233 assertions**,
and the bounded reproduction of the lane collision as the five rows of the two tables above (the
three steps A, B and C and the two controls C0 and C3).

Before the continuation's evidence repair, the pull request's published head was this branch's head.
The branch's head is now one commit ahead of it, and that one commit is a documentation-only change
to this file. It needs the normal publisher's ordinary push, with no history rewrite. Nothing in
this branch is published by the continuation: no credential was created or read, no interactive login
was used, no unauthenticated `gh` call was made, the draft was not marked ready, and no issue was
closed. The draft, once the publisher carries the one commit, is this branch and the three paths
above, with this document as the pull-request body, auto-merge left off, and no issue closed.

Both gates that stood in front of that draft are now closed: the bounded reproduction ran on a
task-owned disposable database with the results recorded above, and the commit carries exactly the
three admitted paths and nothing else. The continuation re-ran the bounded reproduction on a second
task-owned disposable instance and reproduced the same three steps and both controls (Q4, Q9, Q10,
Q11 and Q12), so that gate is closed twice over, on two independent instances.
