# M18.02.2 residual acceptance: authorized portable export and residency (#1226, #1182)

Status: issue **#1226 stays open and partial**. Issue **#1182 stays a rollup**: this file adds
evidence under it and closes nothing under it.

Merged PR #1245 built the export and the restore, and merged PR #1372 proved the authenticated
request path. Both are on current main and neither is rebuilt here. What is left for #1226 is the
part that a merged implementation cannot settle by itself: a single disposable round trip that
states, record by record, what a workspace's export actually carries, what it deliberately does not
carry, what a destination ends up holding, and which stores were never touched at all.

This file records that round trip. It is the evidence for a new test file and nothing else:

- `apps/web/test/integration/portable-export-residual-residency.test.ts` (23 tests; see [The refusal proof repair](#the-refusal-proof-repair) and [The second review round](#the-second-review-round) for the current counts)
- this document

No product source, no shared group or migration file, no UI, no credential and no deployment
changed. Every secret-shaped value in this file's fixture is a synthetic canary: a string the test
generates for the run (`SESSION-DIGEST-<run>`, `ARTIFACT-LOCATOR-<run>` and so on, an `example.test`
invitation email, an invitation token the test mints itself) inside a disposable database. None is a
real credential, a digest of one, or a value taken from a live system. The base was `ee31982e70406ab5de447a79603d6545ac11359f` on branch
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
| Group             | participants-only channel with five messages, two human participants with an audience grant each, and one Agent participant with an enlistment grant                                                                                    |
| Visible project   | workspace-visible, with its primary channel (no messages) and a conversation channel holding four messages, a job publication and a tombstone; two tasks and one task dependency                                                        |
| Members project   | members-only, with its primary channel (no messages) and a conversation channel holding one message; one task                                                                                                                           |
| Artifact          | an object-store artifact with a locator and provenance, and an external-harness artifact, both linked from one message; only the object-store artifact is granted to a second workspace                                                 |
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

Four disposable destination databases are created on the lane's throwaway provisioning instance,
migrated from the repository's migrations, and dropped again. The owner's bundle is restored into
one, the outsider's bundle into a second, and a forged-exporter bundle into a third. The fourth is
provisioned with the users a restore needs and never has a workspace restored into it: it is the
destination every refusal case is posted to. Each is created when the first test that needs it runs, because a full schema migration is heavy work and
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
| E9    | Malicious manifests, ordering and collision errors are refused and write nothing: every row of every app table is compared before and after each refusal                                              | `a malicious manifest is refused and writes nothing`, `ordering and collision errors are refused and write nothing`                                                |
| E9b   | The before and after comparison itself detects a write: a restore, one inserted row and one changed column each fail it, and it stays quiet when nothing changed                                      | `the no-write comparison notices a write, and only a write`                                                                                                        |
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
participants and group admissions each hold exactly as many rows as the bundle carries records for. The two group grant tables are tied to the
bundle's participants, not to any grant record, because the bundle carries none: the destination
holds one audience grant for each human group participant and one enlistment grant for each Agent
group participant (here two and one), and the group admissions match the participants (here three).
The three group tables, the three workspace-event tables and the membership row are the
destination's own: they are what the importer writes for itself (the importer's membership, its
freshly issued grants and admissions, and its own creation event), not the source's rows carried
over. The destination's event log holds exactly one event, `workspace.created`, and exactly one
membership, the importer's.

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

The owner's document carries seven content references, and every one of them travels as metadata
only: a body the local authority holds, a body it holds but cannot serve, a body it does not hold,
a removed body, an E2E-synchronized body, a task objective body and a task objective body in the
members-only project (the outsider's document carries fewer; see E14). Six of the seven travel as
`bodyState: 'local_authority'` and arrive as `availability: 'missing'`; the one the authority
removed travels as `bodyState: 'deleted'` and arrives as `availability: 'deleted'`. The test walks
every restored row and compares it with its bundled reference: the count is the bundle's, the
`storagePolicy` stays `local_authority`, and the `synchronizationPolicy` is exactly the bundled one,
never upgraded: the one `agent_hq_e2ee_sync` reference stays `agent_hq_e2ee_sync` and the six
`local_only` references stay `local_only`. No body, and no replica row, reaches the destination.

Every withheld external domain is reported: `artifact_bytes_and_locations`,
`control_plane_identifiers`, `e2e_ciphertext_replicas`, `remote_content_envelopes` and
`runtime_execution_state`, each with `status: 'unavailable'`, its authority and its treatment,
and each named by the ledger the bundle carries.

### E9 and E10, refusals

Every refusal case is posted to the refusal destination, which holds the provisioned users a
restore needs and no workspace, so a bundle that was not refused would restore into it. No test
restores a workspace into that destination. The forged-exporter case, which does restore, has a
destination of its own.

Each refusal is wrapped by one helper that reads every row of every app table before the attempt,
asserts the destination holds no workspace, posts the bundle, asserts the status, and reads every
row of every app table again. The two snapshots must be equal, and a difference names the tables
that changed. The comparison is not scoped to the restored workspace: a refusal that wrote into a
provisioned user, another workspace's rows or a table nobody listed fails it. It runs after every
refusal, so an earlier refusal that wrote cannot be masked by a later one that did not. Sequence
counters are not part of the snapshot; only row contents are claimed.

Malicious manifests: an unknown top-level field, a wrong format version, an extra ledger class,
an unknown field inside a record, a tampered body, and a document carrying an own `__proto__`
property. The first four are `invalid_document` with the expected issue code; the tampered body is
`digest_mismatch`; the `__proto__` document is refused and `Object.prototype` is unchanged
afterwards. A refusal names the offending path and never the value it found.

Ordering and collision errors: a duplicated message, a `channelOrder` gap, a duplicated channel, a
content reference that resolves to nothing, a task that depends on itself, and a channel run that
is broken across the list. Each is `invalid_document` with `duplicate`, `invariant` or `closure`,
each is asserted to differ from the authorized bundle, and each is held to the same before and
after comparison as the manifests.

The comparison is shown to be sensitive by its own test (E9b): a restored workspace changes
`channels`, `messages`, `workspace_memberships` and `workspaces`; one inserted user changes only
`users` and the comparison fails; one changed column of that row changes only `users`; removing the
row restores equality. Two throwaway mutations of the importer's refusal path were also run against
the repaired file and are recorded under [The refusal proof repair](#the-refusal-proof-repair).
No production importer write defect is established by any of this: the mutations were local and
were reverted, and the importer was not changed.

A forged `exportedBy` is accepted as data and ignored as authority: the importer becomes the
owner, and the bundle's claim about another user transfers nothing.

### E11, the canaries

The secret canaries are asserted to be present in the source first, so their absence elsewhere is
a real exclusion and not an absence that was never there. The invitation's raw token is never
stored: its digest is, and the digest is the canary. One scan helper checks every exported bundle
(owner's, member's and outsider's) and every restored destination dump for all of them: the
secret canaries, the invitation's raw token and the invitation's stored digest. It asserts the
token and the digest are nonempty and distinct before it scans, so an unset value cannot pass as an
absent one. A separate test leaks each secret into each bundle, as a field of its own and inside an
ordinary message body, and requires the scan to fail on every one, with the unmodified bundle as the
control. That mutation is at the level of the scan; the exporter itself was not mutated to leak. The private plaintext canaries are present in
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
sort order and source kind of each project. "Removed" for a message means its deletion time. The
identifiers are compared as sets in the other direction too: the document names exactly the source's
messages (less the withheld job publication), content references, tasks, Agents and projects, no
more and no fewer, so nothing in the document is invented and nothing is altered.

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
upgraded. The removal time is asserted absent on every restored reference the authority did not
remove, not only on one of them.

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

| #   | Command                                                                                                                                                                                                                                                             | Exit | Result                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `bun scripts/run-with-capture-provisioning.mjs -- bun --conditions=react-server test --preload ./scripts/test-solid-transform.ts --timeout 30000 apps/web/test/integration/portable-export-residual-residency.test.ts`                                              | 0    | 19 pass, 0 fail, 638 assertions                                                                                                                                                                                                                                                                                                                                                                          |
| C2  | `bun scripts/run-with-capture-provisioning.mjs -- bun test --parallel --conditions=react-server --preload ./scripts/test-solid-transform.ts --timeout 30000` over the residual file and the five merged portable route-flow files                                   | 0    | 77 pass, 0 fail, 1016 assertions across 6 files. The first measurement of this row, 74 pass and 724 assertions, predated the residual file's second round; the continuation re-measured it against the file the branch now carries (Q7)                                                                                                                                                                  |
| C3  | `bun scripts/run-with-capture-provisioning.mjs -- bun --conditions=react-server test --timeout 30000` over the six `packages/db/tests/integration/portable-*.test.ts` files                                                                                         | 0    | 61 pass, 0 fail, 338 assertions across 6 files. The first measurement of this row, 60 pass and 325 assertions, was taken against the pre-repair channel-bounds file; the continuation re-measured it against the repaired file and against the pre-repair file, to show which is which (Q6, Q8). The third phase re-measured it after the three-family regression was added, which is the 338 here (Q14) |
| C4  | `bun test` over the four portable unit files and `packages/types/tests/portable-export.test.ts`                                                                                                                                                                     | 0    | 48 pass, 0 fail, 257 assertions across 5 files                                                                                                                                                                                                                                                                                                                                                           |
| C5  | `bun scripts/database-health.mjs`                                                                                                                                                                                                                                   | 0    | `Database health check passed (database=agent_hq, runtimeRole=agent_hq_local_app, migrationRole=agent_hq_local_migration)`                                                                                                                                                                                                                                                                               |
| C6  | `bun run --cwd packages/db db:migrate`                                                                                                                                                                                                                              | 0    | `Migration verification passed (61 applied migration(s))`                                                                                                                                                                                                                                                                                                                                                |
| C7  | `bunx tsc -p packages/db/tsconfig.json --noEmit`                                                                                                                                                                                                                    | 0    | no diagnostics                                                                                                                                                                                                                                                                                                                                                                                           |
| C8  | `bunx tsc -p packages/types/tsconfig.json --noEmit`                                                                                                                                                                                                                 | 0    | no diagnostics                                                                                                                                                                                                                                                                                                                                                                                           |
| C9  | `bunx tsc --ignoreConfig --noEmit --strict --target ES2023 --lib ES2023,DOM --module ESNext --moduleResolution bundler --skipLibCheck --types bun-types --esModuleInterop --resolveJsonModule apps/web/test/integration/portable-export-residual-residency.test.ts` | 0    | no diagnostics                                                                                                                                                                                                                                                                                                                                                                                           |
| C10 | `bunx oxlint --deny-warnings apps/web/test/integration/portable-export-residual-residency.test.ts`                                                                                                                                                                  | 0    | no findings                                                                                                                                                                                                                                                                                                                                                                                              |
| C11 | `bunx oxfmt --check apps/web/test/integration/portable-export-residual-residency.test.ts`                                                                                                                                                                           | 0    | `All matched files use the correct format.`                                                                                                                                                                                                                                                                                                                                                              |
| C12 | `bun test scripts/integration-inventory.test.ts`                                                                                                                                                                                                                    | 0    | 20 pass, 0 fail (the new route-flow file is discovered by the lane's own inventory)                                                                                                                                                                                                                                                                                                                      |
| C13 | `bun test scripts/capture-provisioning.test.ts scripts/run-with-capture-provisioning.test.ts`                                                                                                                                                                       | 0    | 53 pass, 0 fail                                                                                                                                                                                                                                                                                                                                                                                          |
| C14 | `bun scripts/run-with-capture-provisioning.mjs -- bun test --parallel --conditions=react-server --preload ./scripts/test-solid-transform.ts --timeout 30000` over every file in `apps/web/test/integration`                                                         | 0    | 347 pass, 0 fail, 8291 assertions across 33 files                                                                                                                                                                                                                                                                                                                                                        |
| C15 | `git fetch origin main`                                                                                                                                                                                                                                             | 0    | `origin/main` is `73e444f59eb3526f5b18f985c2b2f1f9ae302d5a`, and the base commit is an ancestor of it. The continuation re-fetched it: `origin/main` is now `f3cf912d093fbf163a107c3b197e237c81f2c2bb`, and the base commit is still an ancestor of it, so the branch is still behind main rather than diverged from it; the three paths are still untouched by it (Q13)                                 |
| C16 | `git fetch origin "pull/1549/head:refs/remotes/origin/pr-1549"`                                                                                                                                                                                                     | 0    | the pull request's head is `1dc887d74aacc52ff4237a9025283535f40ceb52`, this branch's own commit. The continuation re-fetched it: the pull request's head is now `7afd68613d4e3d70401c2e74a144ed8ce97636ff`, which is this branch's own head, so the branch's four commits are on the pull request (Q13)                                                                                                  |
| C17 | the residual acceptance file on a fresh task-owned source database                                                                                                                                                                                                  | 0    | 19 pass, 0 fail, 638 assertions                                                                                                                                                                                                                                                                                                                                                                          |
| C18 | the five other `packages/db` portable integration files on the same task-owned database                                                                                                                                                                             | 0    | 50 pass, 0 fail, 233 assertions                                                                                                                                                                                                                                                                                                                                                                          |
| C19 | `packages/db/tests/integration/portable-export-channel-bounds.test.ts` on the same task-owned database                                                                                                                                                              | 0    | 11 pass, 0 fail, 101 assertions — the first phase's count. The file with the three-family regression is 11 pass, 0 fail, 105 assertions; see Q14                                                                                                                                                                                                                                                         |
| C20 | `bun run --cwd apps/web cf-typegen` in this worktree                                                                                                                                                                                                                | 0    | the pinned generator ran, but the body it wrote was the network's parked page, 44,884 bytes; it was discarded and never used                                                                                                                                                                                                                                                                             |
| C21 | the Miniflare dispatch probes (a constant worker, `dummy.com`, `example.com`, `localhost`, and the same dispatch with the egress blocked)                                                                                                                           | 0    | every dispatch left the machine, so the parked page is the network's answer                                                                                                                                                                                                                                                                                                                              |
| C22 | `bun run typecheck` with the verified official artifact in this worktree                                                                                                                                                                                            | 0    | `No type errors in 325 files`                                                                                                                                                                                                                                                                                                                                                                            |
| C23 | the repository's pre-commit gate (format check, then type check)                                                                                                                                                                                                    | 0    | the format check passed and the type check passed                                                                                                                                                                                                                                                                                                                                                        |
| C24 | `bun check -p tsconfig.json` at the repository root                                                                                                                                                                                                                 | 1    | not the repository's gate and not green on this base: 12 distinct entries over about 500 files, dominated by `TS2550 toSorted` because the root config's `lib` is ES2022 while every package config uses ES2023. This branch's two test files appear in that summary with the same per-file counts as the pre-existing merged portable files (13 each), so nothing here is specific to this change.      |

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

These five mutations were measured in an earlier phase, against the residual file as it stood then
(16 tests, which is why the pass counts read 15, 7 and 0). They were not re-run against the current
file. Every test name they cite still exists. The two later throwaway mutations of the importer's
refusal path are recorded under [The refusal proof repair](#the-refusal-proof-repair).

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

1. it plants the legacy identifiers of **all three fixed families** as leftover rows — the
   late-project channel, the participant-boundary channel, and one member of the heavy visible
   scale range — in the lane database, tolerating a leftover that is already there, because
   "already there" is the condition under test;
2. it asserts that all three planted rows are really present, so the case cannot pass on a plant
   that silently did not happen;
3. it asserts that no identifier this run creates is one of those fixed identifiers — the scale
   family is checked at both of its ends — and that the run's identifiers are distinct from each
   other;
4. it then creates the run's own fixtures **while the leftovers are present**, and asserts the rows
   exist.

The plant, the assertions and the removal happen inside one seed lifetime, described next. With the
pre-repair fixture the case fails on the insert with `23505 duplicate channels_pkey`, the recorded
error. With the repair it passes. The leftover rows are participant-only channels with no
participants: the collision is on the primary key alone, and such a row is invisible to every
other assertion in the file, so the leftovers cannot perturb the cases that follow.

#### The seed lifetime

The legacy identifiers are fixed and global, so this case is the one place two runs of the file can
still meet. Planting with `onConflictDoNothing` and reading the rows back was not safe by itself: a
concurrent run B that finds run A's rows asserts on A's rows, and A's workspace-scoped teardown then
removes them from under B before B's last assertion. The case now runs inside
`withLegacyChannelSeed`, which holds one session-level PostgreSQL advisory lock for the whole
lifetime of the seed: acquire (a bounded wait of 120 seconds, by polling, that fails with a named
error rather than hanging), plant, assert, remove, release. A second run waits until the first has
finished, then plants its own rows and asserts on those. The rows a run removes are exactly the ones
its own insert returned; a leftover that was already there (the condition under test) and every
row that belongs to anyone else are left in place, and the presence assertions are unchanged.

The self-tests start their callers through `runWithSettledCallers` (see [The third review
round](#the-third-review-round)), so a failure of one caller cannot leave another running when the
fixture rows are deleted. A self-test of the helper uses ids and a lock name of its own run, so it cannot touch the real
legacy rows or another run's lock. It shows that a second connection cannot take the lock while the
first run holds it; that a second caller started during the first run does not enter until the
first has left, and then plants its own row (the first run's row is gone) while the leftover is
still the original one, untouched by either; that the lock is released and the planted rows are
removed when the body throws; and that a lock nobody releases becomes a bounded, named failure. Three
copies of the file were also run at the same time against one database and all passed. The previous
fixture also passed three concurrent copies, so the race is narrow and was **not** reproduced
against it; the claim made here is the deterministic one from the self-test, not that the old race
was observed. The lock protects only runs of this file that go through the helper. A run of the
pre-repair fixture, or any other writer of these ids, is outside what a lock this file takes can
protect.

### The bounded reproduction, and its result

The reproduction ran on this worker's own disposable PostgreSQL instance, on two databases created
there with the repository's own migrations, and it used the repository's own test invocation
(`bun --conditions=react-server test --timeout 30000`, the local-target timeout the integration
lane uses; no timeout was raised).

The `f3w4_channel_bounds_repro` database carries the leftover rows with the legacy primary keys,
planted the way an interrupted earlier run would have left them, in a workspace of their own. The
first phase of this work seeded two of the three families, because the recorded receipt named two
of them; the second phase seeded all three, because the defect is a family and the regression
should cover the family and not only the members a receipt happened to carry.

| Step | Fixture              | Condition                            | Exit | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | -------------------- | ------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | pristine, pre-repair | the three seeded legacy rows present | 1    | 7 pass, 3 fail, and **no** test is left to assert anything. `PostgresError: duplicate key value violates unique constraint "channels_pkey"`, code `23505`, three times, on one member of each family: `Key (id)=(ffffffff-ffff-4fff-8fff-ffffffffffff) already exists` (the recorded lane failure, byte for byte) in `mid-export project grants cannot expand channel or participant reads past the snapshot`; `Key (id)=(00000000-0000-4000-8000-000000000001) already exists` in `reads complete participant summaries in bounded pages and rejects one over the export cap`; and `Key (id)=(00000000-0000-4000-8000-000000000000) already exists` in `materializes exactly 10,000 participants and refuses 10,001 before detail transfer`. The first phase's two-family seed produced 8 pass and 2 fail, with the same two errors. |
| B    | repaired             | the same seeded rows still present   | 0    | 11 pass, 0 fail, 105 assertions, and **no** duplicate-key error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| C    | repaired, repeated   | the same seeded rows still present   | 0    | 11 pass, 0 fail, 105 assertions. Two patched runs in a row against one database both succeed, which is the repeat-run isolation the repair is for, and all three seeded rows are still present afterwards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Two controls on a second, clean database isolate the repair from the leftovers:

| Control | Fixture              | Condition      | Exit | Result                                                                                                                  |
| ------- | -------------------- | -------------- | ---- | ----------------------------------------------------------------------------------------------------------------------- |
| C0      | pristine, pre-repair | clean database | 0    | 10 pass, 0 fail, 92 assertions — the base file is green, so the step-A failure is the seeded condition and not the file |
| C3      | repaired             | clean database | 0    | 11 pass, 0 fail, 105 assertions                                                                                         |

The first version of the repair failed the C3 control on a clean database: it scoped the identifiers
to the run but moved the heavy-scale family to the high end of the identifier space, which changed
two order-sensitive assertions of the base file (the participant batch no longer split at 156
channels, and the export met the participant-bound channel on its last page instead of its first).
The repair was corrected to preserve the identifier positions, and the table above records the
corrected result. That correction is why the identifier _position_ is now part of the recorded
contract of this fixture.

**Attribution.** The evidence supports the fixture attribution and nothing else. The pristine
fixture fails on exactly the recorded primary key and on the other two members of the same family
once they are seeded, the repaired fixture passes with those same rows still in the database, and
the product's `channels_pkey` is correct and untouched. This file does **not** claim to know which
of the two conditions produced the row in the lane that recorded the failure — an interrupted run,
or a concurrent run against one shared lane database. The shared index receipt does not say, and
this file does not guess: the repair removes the dependence on which one it was.

### The other checks in this phase, with raw exits

| Command                                                                                                                                     | Exit | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docker inspect f3w4-postgres-26493c8c --format …`                                                                                          | 0    | the task-owned container: the repository-pinned postgres digest, `127.0.0.1:55439` -> 5432, running since `2026-10-21T09:02:22Z` — the identity in this worker's own creation receipt                                                                                                                                                                                                                                                                                                                                          |
| `docker exec f3w4-postgres-26493c8c psql … -d f3w4_channel_bounds_repro`                                                                    | 0    | both seeded legacy primary keys present, 61 migrations, one workspace, one user — the first phase's two-family seed. The second phase seeds all three families; see Q14                                                                                                                                                                                                                                                                                                                                                        |
| `bunx oxfmt --check packages/db/tests/integration/portable-export-channel-bounds.test.ts`                                                   | 0    | `All matched files use the correct format.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `bunx oxlint --deny-warnings packages/db/tests/integration/portable-export-channel-bounds.test.ts`                                          | 0    | no findings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `bunx tsc --ignoreConfig --noEmit …` on the pristine file and on the repaired file                                                          | 1    | 34 diagnostics each, byte-identical after normalizing line and column: the repair adds no type diagnostic and changes none. The file is outside the repository's type gate, which covers `packages/db/src`, and the 34 diagnostics are pre-existing on the base commit. The third phase re-measured the same comparison — pristine against the three-family repaired file, both at the same in-repo path — and got 12 diagnostics each, again byte-identical after normalizing line and column, so the change adds none (Q19). |
| `bun run --cwd packages/db db:migrate` against both reproduction databases                                                                  | 0    | `Migration verification passed (61 applied migration(s))`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| the leftover-row plant                                                                                                                      | 0    | `INSERT 0 1`, `INSERT 0 1`, `INSERT 0 2` — the first phase's two-row plant. The second phase's three-family plant is `INSERT 0 1`, `INSERT 0 1`, `INSERT 0 1`, `INSERT 0 3`; see Q14                                                                                                                                                                                                                                                                                                                                           |
| the repaired file on the clean database, step C3 above                                                                                      | 0    | 11 pass, 0 fail, 101 assertions — the first phase's count. The repaired file with the three-family regression is 11 pass, 0 fail, 105 assertions; see C3, C19 and Q14                                                                                                                                                                                                                                                                                                                                                          |
| the residual acceptance file, `apps/web/test/integration/portable-export-residual-residency.test.ts`, on a fresh task-owned source database | 0    | 16 pass, 0 fail, 346 assertions — the residual file as it stood in this phase. The file the branch finally carries is 19 tests and 638 assertions; see C1, C17 and Q1                                                                                                                                                                                                                                                                                                                                                          |
| the five other `packages/db` portable integration files on the same task-owned database                                                     | 0    | 50 pass, 0 fail, 233 assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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
task-owned instance only. Rows Q1 to Q13 are the second phase's measurements, on the branch as it
stood then; rows Q14 to Q20 are the third phase's, on the branch as it stands now, and they are
the ones that describe the file the branch finally carries.

| #   | Command                                                                                                                                                                                                                                                                                             | Exit | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | the residual acceptance file on a fresh task-owned source database                                                                                                                                                                                                                                  | 0    | 19 pass, 0 fail, 638 assertions                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Q2  | the residual acceptance file, repeated, on the same source database                                                                                                                                                                                                                                 | 0    | 19 pass, 0 fail, 638 assertions; the source database held zero workspaces, users, channels, messages and tasks afterwards, and no scratch database survived                                                                                                                                                                                                                                                                                                         |
| Q3  | the residual acceptance file on the seeded database, with the two legacy primary keys still present                                                                                                                                                                                                 | 0    | 19 pass, 0 fail, 638 assertions; both seeded rows still present and untouched                                                                                                                                                                                                                                                                                                                                                                                       |
| Q4  | the repaired channel-bounds file on a clean task-owned database                                                                                                                                                                                                                                     | 0    | 11 pass, 0 fail, 101 assertions                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Q5  | the five other `packages/db` portable integration files on the same database                                                                                                                                                                                                                        | 0    | 50 pass, 0 fail, 233 assertions                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Q6  | the six `packages/db` portable integration files, with the repaired channel-bounds file                                                                                                                                                                                                             | 0    | 61 pass, 0 fail, 334 assertions across 6 files                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q7  | the residual file and the five merged portable route-flow files, in parallel                                                                                                                                                                                                                        | 0    | 77 pass, 0 fail, 1016 assertions across 6 files                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Q8  | the same six `packages/db` portable integration files, with the **pre-repair** channel-bounds file                                                                                                                                                                                                  | 0    | 60 pass, 0 fail, 325 assertions across 6 files — the first measurement of C3, reproduced                                                                                                                                                                                                                                                                                                                                                                            |
| Q9  | the bounded reproduction, step A: the pre-repair file on the seeded database                                                                                                                                                                                                                        | 1    | 8 pass, 2 fail. `PostgresError: duplicate key value violates unique constraint "channels_pkey"`, code `23505`, on `Key (id)=(ffffffff-ffff-4fff-8fff-ffffffffffff) already exists` and then on `Key (id)=(00000000-0000-4000-8000-000000000000) already exists` — the recorded lane failure, byte for byte                                                                                                                                                          |
| Q10 | the bounded reproduction, step B: the repaired file on the seeded database                                                                                                                                                                                                                          | 0    | 11 pass, 0 fail, 101 assertions, and no duplicate-key error                                                                                                                                                                                                                                                                                                                                                                                                         |
| Q11 | the bounded reproduction, step C: the repaired file, repeated, on the same seeded database                                                                                                                                                                                                          | 0    | 11 pass, 0 fail, 101 assertions; two patched runs in a row against one database both succeed                                                                                                                                                                                                                                                                                                                                                                        |
| Q12 | the control: the pre-repair file on a clean database                                                                                                                                                                                                                                                | 0    | 10 pass, 0 fail, 92 assertions — the base file is green, so Q9's failure is the seeded condition and not the file                                                                                                                                                                                                                                                                                                                                                   |
| Q13 | the read-only `git fetch origin main` and `git fetch origin "pull/1549/head:refs/remotes/origin/pr-1549"`                                                                                                                                                                                           | 0    | `origin/main` is `f3cf912d093fbf163a107c3b197e237c81f2c2bb`, eleven commits ahead of the base, and the three paths are untouched by it; the pull request's head is `7afd68613d4e3d70401c2e74a144ed8ce97636ff`, this branch's own head                                                                                                                                                                                                                               |
| Q14 | the bounded reproduction on a **three-family** seed: the pre-repair file on the seeded database                                                                                                                                                                                                     | 1    | 7 pass, 3 fail, and no test is left to assert anything. `23505 duplicate channels_pkey` on one member of each family: `Key (id)=(ffffffff-ffff-4fff-8fff-ffffffffffff) already exists` (the recorded lane failure), `Key (id)=(00000000-0000-4000-8000-000000000001) already exists`, and `Key (id)=(00000000-0000-4000-8000-000000000000) already exists`                                                                                                          |
| Q15 | the repaired file on the same three-family seed, and again on a second run against it                                                                                                                                                                                                               | 0    | 11 pass, 0 fail, 105 assertions, twice, and no duplicate-key error; all three seeded rows are still present afterwards                                                                                                                                                                                                                                                                                                                                              |
| Q16 | the controls: the pre-repair file on a clean database, and the repaired file on a clean database                                                                                                                                                                                                    | 0    | 10 pass, 0 fail, 92 assertions, and 11 pass, 0 fail, 105 assertions                                                                                                                                                                                                                                                                                                                                                                                                 |
| Q17 | the repaired channel-bounds file on a clean task-owned database, the six `packages/db` portable files, the residual acceptance file, and the six portable route-flow files                                                                                                                          | 0    | 11 pass, 0 fail, 105 assertions; 61 pass, 0 fail, 338 assertions across 6 files; 19 pass, 0 fail, 638 assertions; 77 pass, 0 fail, 1016 assertions across 6 files                                                                                                                                                                                                                                                                                                   |
| Q18 | `wrangler types --env-interface CloudflareEnv <scratch path>` from `apps/web`, with the pinned 4.147.0                                                                                                                                                                                              | 0    | the tool printed "Runtime types generated." and wrote 45,128 bytes whose body after the `// Begin runtime types` marker is dummy.com's parked page — seven lines of `<!DOCTYPE html>`, `<html lang="spanish" data-theme="dark">`, the page's `<style>`, `<script>` and `<svg>` markup — and `tsc` on that file reports exactly 1,297 parse errors. The worktree's verified artifact was not a candidate for overwriting and is byte-identical at sha256 `9b5e7188…` |
| Q19 | `mise exec -- node --version`, `bunx oxfmt --check`, `bunx oxlint --deny-warnings`, `bunx tsc -p packages/db/tsconfig.json --noEmit`, `bunx tsc -p packages/types/tsconfig.json --noEmit`, the standalone `tsc --ignoreConfig` check of the residual file, `bun test scripts/docs-boundary.test.ts` | 0    | `v24.21.0`; the format check and the lint report clean; both package type checks report no diagnostics; the documentation check is 4 pass, 0 fail, 15 assertions                                                                                                                                                                                                                                                                                                    |
| Q20 | the repository's own pre-commit gate, with the pinned Node on `PATH`, on the committed change                                                                                                                                                                                                       | 0    | the gate ran and passed, with the format check over the changed path and the type check skipped by its own change-aware plan                                                                                                                                                                                                                                                                                                                                        |

Q9's failure is the attribution, again: the pre-repair fixture fails on exactly the recorded primary
key, the repaired fixture passes with that same row still in the database, and the product's
`channels_pkey` is correct and untouched. The reproduction is the same on a second instance, on a
second pair of databases, with a seed written independently of the first phase's.

**The third phase: the family, not only the members a receipt named.** The first phase seeded the
two fixed identifiers that the recorded receipt and the second phase's reproduction named. The
shared index's own entry for this work names **three** families of fixed identifier, and the third
one — the heavy visible scale range, one hundred and fifty-seven ids of the shape
`00000000-0000-4000-8000-` followed by the row's own index — had no deterministic coverage at all: a
leftover row from that family would have collided just as hard, and nothing in the lane would have
said so. The regression now plants one member of that family as well, asserts that all three
planted rows are really present, and asserts that no identifier this run creates equals any of
them, with the scale family checked at both of its ends.

With that third family seeded, the pre-repair fixture fails three times instead of two, on one
member of each family (Q14), and the repaired fixture passes on the same seeded database and again
on a second run against it (Q15). That is the difference between reproducing the recorded failure
and reproducing the defect.

**The generated Workerd baseline.** The third phase re-ran the pinned generator into a scratch path
outside the checkout, so the verified artifact in this worktree was never a candidate for
overwriting, and it measured the failure precisely: the tool exits 0, prints "Runtime types
generated.", and writes the network's parked page into the body after the `// Begin runtime types`
marker (Q18). The effect is the same 1,297 parse errors the first phase recorded, and the marker
plus the `workerd@…` header — the first phase's verification rule — do **not** detect it. The rule
that holds is the body after the marker. That correction is recorded in full under the type-check
blocker section above, and this worktree's verified artifact is byte-identical, at sha256
`9b5e7188…`, 623,606 bytes.

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
_network's_ answer, not the runtime's. It was discarded and never used.

**What was done.** The official artifact for exactly these inputs is verifiable: three independent
worktrees of this fleet hold a byte-identical file (sha256 `9b5e7188…`, 623,606 bytes) whose first
three lines are byte-identical to the ones the pinned tool writes here, and whose body after the
`// Begin runtime types` marker is the official Cloudflare/Microsoft runtime-type bundle. That
artifact was placed in **this** worktree's generated path only — no other worker's file was touched,
and no tracked path changed — and the pinned tool itself accepted it: the `cf-typegen` step that the
type check runs printed "Runtime types generated." and left the file byte-identical, because the
tool reuses an existing body whose header matches. The type check then passed, with the format
check, in the gate itself.

**The third phase re-ran the generator, and the failure reproduces — and the marker alone does not
detect it.** The generator was run into a scratch path outside the checkout, so the verified
artifact in this worktree was never a candidate for overwriting. It exited 0 and printed "Runtime
types generated.", and the body it wrote was 45,128 bytes whose first three lines are the expected
header, whose `workerd@1.20261001.1 2026-08-01` line is the expected one, and which **does** carry
the `// Begin runtime types` marker. The body after that marker is dummy.com's parked page:
`<!DOCTYPE html>`, `<html lang="spanish" data-theme="dark">`, the page's `<style>`, `<script>` and
`<svg>` markup, seven lines of it. The file is the network's answer with the tool's own header
around it, and the tool reports success while writing it.

Two consequences are recorded here rather than smoothed over:

1. **The first phase's verification rule was incomplete.** It accepted an artifact that carries the
   `// Begin runtime types` marker and the `workerd@…` header, and it read the absence of HTML as
   part of that rule. The third phase's generated file carries both markers _and_ the parked page,
   so the marker and the header are necessary but not sufficient. The rule that holds is the
   **body after the marker**: the official artifact continues with the Cloudflare/Microsoft
   copyright banner and the runtime-type bundle, and the failed generation continues with
   `<!DOCTYPE html>`. This worktree's artifact continues with the banner, at line 31, and its
   eight case-insensitive "body"-shaped matches are the generic `Message<Body = unknown>` and
   `Queue<Body = unknown>` type parameters, not markup.
2. **The failure's effect is the same number.** The freshly generated file yields exactly 1,297
   parse errors under `tsc` — `TS1005`, `TS1110`, `TS1161` and the rest — which is the same count
   the first phase recorded for the in-place failure. The first phase's byte count for the parked
   body, 44,884, differs from this phase's 45,128: the parked page's body varies between fetches,
   so the byte count is not a stable identifier of the failure and the parse-error count and the
   body after the marker are.

**The remaining prerequisite.** A worktree that has _no_ valid cached artifact still cannot obtain
one in this environment, because the runtime's RTTI request leaves the machine and the egress
answers with a parked page. The prerequisite is that Miniflare's embedded workerd answers the RTTI
request locally — or that egress returns the official workerd runtime types, verified by the body
after the `// Begin runtime types` marker being the official runtime-type bundle and not the
network's page. Until that holds, a fresh worktree's first generation is poisoned by the network's
answer, and the remedy is to materialise the verified artifact rather than to run the generator
blindly. The third phase did exactly that: it generated into a scratch path, measured the failure,
and left this worktree's verified artifact byte-identical, at sha256 `9b5e7188…`, 623,606 bytes.

## Current main and the pull request

> **Historical.** This section, and the publication table below, describe the third phase, when the
> branch's newest commits were local and could not be pushed. They are kept as recorded. The pull
> request's published head has since advanced to `658b262312cbddb576b17190db2e768250d6edc8`, which
> carries those commits; the head and main as of the refusal proof repair are under
> [The refusal proof repair](#the-refusal-proof-repair).

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

The pull request is #1549. Its published head is `7afd68613d4e3d70401c2e74a144ed8ce97636ff`, read
again in this phase through a read-only fetch with the credential helper disabled and the terminal
prompt disabled. That head carries the branch's first four commits — the fixture repair, the
residual acceptance's first and second rounds, and the type-check provenance record. This branch's
head is **three commits ahead** of it, and the relationship is a fast-forward:
`git merge-base --is-ancestor origin/pr-1549 HEAD` succeeds, and the three commits to be published
are the second phase's evidence repair, this phase's three-family regression, and this phase's
record of the publication attempt. No history rewrite is involved, and no rebase was performed.

**The publication was attempted and could not be completed here.** The ordinary authenticated routes
were tried in turn and each one failed for want of a credential, not for want of a fast-forward:

| Route                                                                          | Result                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git push origin HEAD:refs/heads/codex/f3w4-adea-20261021` over HTTPS          | `fatal: could not read Username for 'https://github.com': terminal prompts disabled`                                                                                       |
| the same push with the repository's configured `credential.helper=osxkeychain` | the same failure: the login keychain holds no `github.com` entry, in any of the spellings `github.com`, `https://github.com`, `git:https://github.com` or `git:github.com` |
| `git push --dry-run git@github.com:adea-ai/adea.git …` over SSH                | `fatal: Could not read from remote repository.` — there is no SSH key in this environment and `ssh -T git@github.com` answers `Permission denied (publickey)`              |
| `gh auth status`                                                               | `You are not logged into any GitHub hosts.` — the GitHub CLI has no auth store here, and `gh auth token` finds no token                                                    |

No credential was created, no interactive login was used, no auth store was read, and no
unauthenticated `gh` call was made. The three commits therefore stay local, and the pull request
keeps its published head. The update the publisher needs is an ordinary fast-forward push of this
branch's head to `codex/f3w4-adea-20261021`, with auto-merge left off, the draft left as a draft,
and no issue closed.

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
- This phase added a third task-owned disposable instance of its own, `f3w4-qual2-postgres-…` on
  `127.0.0.1:55445`, with the repository's own role boundary and migrations, and removed it by name
  with its volume at the end of the round. It re-read the pull request's head through a read-only
  fetch, and it attempted the ordinary authenticated push on the three routes the environment offers
  — HTTPS with and without the configured keychain helper, and SSH — and each one failed for want
  of a credential. No credential was created, no auth store was read, no interactive login was used,
  no `gh` write was made, the draft was not marked ready, nothing was merged and no issue was
  closed.
- The generated `apps/web/cloudflare-env.d.ts` is gitignored and was left byte-identical, at sha256
  `9b5e7188…`, 623,606 bytes. The generator was run into a scratch path outside the checkout, and
  the repository's own hook ran its `cf-typegen` step against the worktree's existing body, which
  the tool reused and left untouched. No other ignored output was modified.

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

The counts this packet quoted in the third phase were: the residual acceptance file at
**19 tests and 638 assertions** (superseded: 22 tests and 694 assertions after the refusal proof
repair), the repaired channel-bounds file at **11 tests and 105
assertions**, the five neighbouring portable integration files at **50 tests and 233 assertions**,
and the bounded reproduction of the lane collision as the five rows of the two tables above (the
three steps A, B and C and the two controls C0 and C3).

Before the second phase's evidence repair, the pull request's published head was this branch's head.
The branch's head is now **three commits** ahead of it: the second phase's documentation-only
evidence repair, this phase's three-family regression with its matching evidence corrections, and
this phase's record of the publication attempt. The
relationship is a fast-forward and it needs the normal publisher's ordinary push, with no history
rewrite. Nothing in this branch is published by this work: no credential was created or read, no
interactive login was used, no unauthenticated `gh` call was made, the draft was not marked ready,
and no issue was closed. The draft, once the publisher carries the three commits, is this branch and
the three paths above, with this document as the pull-request body, auto-merge left off, and no
issue closed.

Both gates that stood in front of that draft are now closed: the bounded reproduction ran on a
task-owned disposable database with the results recorded above, and the commit carries exactly the
three admitted paths and nothing else. The continuation re-ran the bounded reproduction on a second
task-owned disposable instance and reproduced the same three steps and both controls (Q4, Q9, Q10,
Q11 and Q12), so that gate is closed twice over, on two independent instances. This phase closed it
a third time, on a third instance, with the seed extended to the third fixed-identifier family, and
the pre-repair fixture now fails on one member of every family (Q14, Q15, Q16).

## The refusal proof repair

Head the repair started from: `658b262312cbddb576b17190db2e768250d6edc8` (pull request #1549, a
draft with auto-merge off, read through the REST API before any change; `codex/f3w4-adea-20261021`
had no newer commit). The pull request's body had still quoted the earlier head
`7afd68613d4e3d70401c2e74a144ed8ce97636ff` and the first phase's 16 pass / 346 assertion count;
it is corrected with this update.

**What was wrong.** The old refusal cases did not prove what the evidence said they proved. The
forged-exporter case restored a workspace into the same destination the other refusal cases used,
and its position in the file decided whether the ordering and collision cases ran against an
empty destination or a populated one. The six ordering and collision bundles were then posted with
a status and an issue-code assertion each and no assertion about state after any of them, so the
claim "refused and write nothing" rested on nothing for that test. The malicious-manifest case
asserted emptiness once, at its end, against a destination that held no provisioned users, so a
refusal that rewrote a provisioned identity would not have been seen.

**What changed (the test file and this document only).**

- The refusal destination is provisioned with the users a restore needs and never restored into.
  The forged-exporter restore moved to a destination of its own.
- Every refusal is wrapped by `refuse(...)`: no workspace before, the expected status, and an
  equal snapshot of every row of every app table after.
- `the no-write comparison notices a write, and only a write` shows the comparison fails on a
  restore, on one inserted row and on one changed column, and passes again once the row is gone.
- The test header counts, the destination description, the refusal section above and the
  synthetic-canary wording at the top of this file are corrected.

**Measurements** (PostgreSQL 18.4, a local `embedded-postgres` 18.4 build, because Docker was not
available in this environment; the schema was migrated with `packages/db/src/verify-migrations.ts`,
61 migrations; `DATABASE_URL` was the application role and
`MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL` a superuser URL on the same instance, supplied directly
instead of through `scripts/run-with-capture-provisioning.mjs`; the pinned container image was not
used):

| Run                                                                                                        | Result                                                                                |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| the residual file at `658b262`, before the repair                                                          | 21 pass, 0 fail, 650 assertions                                                       |
| the repaired file, twice in a row                                                                          | 22 pass, 0 fail, 694 assertions, both times                                           |
| mutation M6: the importer's `invalid_document` / `digest_mismatch` path rewrites every user's display name | 21 pass, 1 fail: `a malicious manifest is refused and writes nothing`, naming `users` |
| mutation M7: the same path inserts one stray user per refusal                                              | 20 pass, 2 fail: the malicious-manifest case and the ordering and collision case      |
| `oxfmt --check` and `oxlint --deny-warnings` on the test file                                              | clean                                                                                 |
| standalone `tsc --ignoreConfig` of the test file, base and repaired                                        | the same single error count (1) both times; the file itself reports none              |

M6 and M7 were applied to `apps/web/src/server/portable-workspace-request.ts` for one run each and
reverted; the importer is unchanged in this update. M6 matters because it changes a provisioned row without changing any row count, which a census of counts cannot see; M7 matters because it repeats, so each refusal has to be checked on its own.

**Main.** `origin/main` is `65e3880a11c97660ddfc42cce5024dbc6bee148a`, 29 commits past
`beb62c2b0d25f057f9de3cbb681e60f365bfe433`, the base GitHub records for the pull request. Over the
test file, this document, the channel-bounds test, `portable-workspace-request.ts` and
`packages/db/src/portable*`, the difference between those two commits is empty. The branch is not
rebased and not updated from main here.

**Not run, so not claimed:** the repository's pre-commit type check (it generates
`apps/web/cloudflare-env.d.ts`, which this environment cannot do honestly), the six portable
route-flow files in parallel, the Docker provisioning runner, and hosted CI. The broad integration,
coverage, packaged and native gates remain open as stated above. No live data, credential or
deployment was used.

## The second review round

The pull request's head when this round started was `a51a819aec468a8508479f66d0abe13dd55a70dc`,
still a draft with auto-merge off. Root's review of that head asked for two bounded test repairs and
for the evidence document to be checked against the actual assertions and fixtures. Nothing in this
round touches product source, claims a product defect, or closes an issue.

**Test repairs.**

- _Invitation secrets in the bundle scans._ The three exported-bundle scans checked the secret
  canaries but not the invitation's raw token or stored digest, which only the restored dumps
  checked. One scan helper now covers bundles and dumps alike, asserts the token and the digest are
  nonempty and distinct first, and a new test (`a bundle that leaks any secret, including the
invitation token or its digest, fails the scan`) leaks each secret into each bundle, twice, and
  requires the scan to fail on all of them.
- _Channel-bounds seed lifetime._ Described under [The seed
  lifetime](#the-seed-lifetime): an advisory lock for the whole seed, removal of only the rows the
  run inserted, and a self-test of the helper.

**Claims checked against the tests.** Each claim in the sections that describe the fixture and the
round trip was compared with the test code and with fixture facts logged from a run (table census,
per-family record counts, per-channel message counts). Corrections and additions:

| Claim as it stood                                                                                     | Finding                                                                                                                                                                                                                                 | Action                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E7: group audience and enlistment grants each hold exactly as many rows as the bundle carries records | The bundle carries no grant records, and the test only required the two tables to be populated                                                                                                                                          | Wording corrected; assertions added: audience grants equal the human group participants, enlistment grants equal the Agent group participants          |
| E7: "the four workspace-event tables"                                                                 | There are three (`workspace_event_dispatches`, `workspace_event_sequences`, `workspace_events`); the fourth table in that group is `workspace_memberships`                                                                              | Wording corrected                                                                                                                                      |
| E7/boundary: the destination logs its own `workspace.created` event                                   | Only the row count was asserted                                                                                                                                                                                                         | Assertion added: the destination's events are exactly `['workspace.created']`, and exactly one membership                                              |
| E8: "Four content references travel as metadata only"                                                 | The owner's document carries seven (the fixture makes seven); four is the number of body states E14 covers                                                                                                                              | Corrected to seven, with the 6/1 split by body state and the 1/6 split by synchronization policy; the per-row test already covered all seven           |
| E8: "a body the local authority no longer holds travels as `deleted`"                                 | Only a body the authority removed is `deleted`; a body it does not hold is `local_authority` (E14)                                                                                                                                      | Wording corrected                                                                                                                                      |
| Fixture: "Visible project ... a channel, seven messages"                                              | The visible project has a primary channel with no messages and a conversation channel with four messages, a job publication and a tombstone: six stored rows, five carried. The group channel carries five. The document carries eleven | Table corrected                                                                                                                                        |
| Fixture: Artifact "both ... granted to a second workspace"                                            | One grant exists, for the object-store artifact                                                                                                                                                                                         | Table and the test's comment corrected                                                                                                                 |
| E13: "Nothing in the document is invented"                                                            | The test compared source rows to the document, not the document to the source                                                                                                                                                           | Assertions added: the document's message, content reference, task, Agent and project identifiers equal the source's, less the withheld job publication |
| E14: removal time "absent for the others"                                                             | Asserted for one reference only                                                                                                                                                                                                         | Assertion added for every reference the authority did not remove                                                                                       |
| E11: invitation token and digest absent from bundles                                                  | Not asserted for bundles                                                                                                                                                                                                                | Covered by the scan helper above                                                                                                                       |
| Mutation checks M1 to M5                                                                              | Measured on an earlier 16-test file                                                                                                                                                                                                     | Labelled as such; not re-run                                                                                                                           |

Checked and found consistent with the tests: the 57 / 46 / 11 table census, the 18 populated and 28
empty workspace-scoped tables (the lists were regenerated from a run), the two provisioned users,
the nine empty unscoped tables, the E2 and E12 ordering rules, the E13 field lists, the E5 and E6
descriptions, the E9 and E10 descriptions, and the "does not prove" list.

**Measurements** (PostgreSQL 18.4, the same local build and setup as in the refusal proof repair):
the residual file passes 23 tests with 1,533 assertions, and the channel-bounds file passes 12
tests with 121 assertions. Format and lint are clean on the three changed files. A mutation of the
importer that issues too few audience grants was tried and discarded: it broke the restore itself,
through the admissions that reference the grants, so it did not isolate the new count assertions and
is not claimed as evidence for them.

**Still open.** Hosted CI has not run on this head (a draft skips most lanes); the repository's
pre-commit type check, the route-flow lane and the Docker provisioning runner were not run; and the
review of this document as a whole is not complete, so nothing here is a claim of approval,
readiness or issue closure.

## The third review round

The head when this round started was `1d93a5c7a6354e945408c7885c0ff8903bb09283`, a draft with
auto-merge off. Root's complete review of that head found one more source defect, in the helper
self-test added in the second round: it started run B inside run A, awaited A, and awaited B only
afterwards. If A rejected, the `await runB` line was skipped and the `finally` deleted the fixture
rows while B could still be waiting for, or holding, the lock, and B's rejection was never observed.
This is a defect in the test code only; the helper under test was not wrong.

**Repair (the channel-bounds test file and this document only).**

- `runWithSettledCallers(scenario, teardown)` runs a scenario that starts callers through a `start`
  function. `start` attaches a rejection observer the moment a caller starts, so no rejection can go
  unhandled, and keeps the original promise. Whatever the scenario does, including throwing before it
  awaits a caller, every started caller is settled before the teardown deletes anything.
- The scenario's own failure is the primary error. A started caller's rejection that is not that
  same error, and a failing teardown, are cleanup errors. A lone primary error is rethrown as it was;
  otherwise one `AggregateError` carries the primary first and then every cleanup error.
- The teardown of the main self-test removes the fixture rows and then asserts the advisory lock is
  free (`assertAdvisoryLockFree`, which takes and releases the lock on a connection of its own, so a
  forgotten lock is a named failure, not a hang). Callers that the scenario awaits on the spot (the
  failing body and the bounded wait) are not registered, because they cannot be abandoned.
- A new test, `a failing first caller is settled together with the second one before teardown`,
  makes run A fail while B is waiting for the lock and has the scenario throw before it ever awaits
  B. At teardown B had entered, finished and removed its own row, the leftover row was still the
  original, the lock was free, and the harness rethrew exactly A's error. Another new test checks the
  harness itself: a lone primary comes back as itself after an abandoned caller settled; the
  primary, an abandoned caller's rejection and a failing teardown arrive together, in that order; a
  failing teardown fails a passing scenario; and a caller that rejects after a passing scenario is
  not swallowed.

**Measurements** (PostgreSQL 18.4, the same local build as before). The channel-bounds file passes 14
tests with 132 assertions, and no advisory lock or run-scoped fixture row remained in the database
afterwards. `oxfmt --check` and `oxlint --deny-warnings` are clean. As a mutation, the harness was
changed to stop settling started callers (`await Promise.allSettled(started)` replaced by `[]`): the
failing-first-caller test failed, naming the lock as still held, and the harness test failed too.
The mutation was reverted. The residual file was not changed in this round.

**Still open.** As in the second round: hosted CI has not run on this head, and the document review
is not claimed complete. Nothing here is a claim of approval, readiness or issue closure.
