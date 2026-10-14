# Artifact-reference sharing grants

An artifact-reference grant lets one audience workspace read one exact artifact
version from a granting workspace. The grant store
(`packages/db/src/artifact-reference-grants.ts`) is the only authority. The routes
below parse requests and map the store's typed refusals. They never supply
authority, and a grant is never restored by replaying a request.

## Routes

All routes are under `/api/v1/workspaces/:workspaceId`. The path workspace is the
caller's own workspace.

| Route                                       | Who may call it                          | Effect                                                                                                          |
| ------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `POST .../artifact-grants`                  | owner or admin of the granting workspace | Registers a grant at revision 1. `201` when new; `200` with `outcome: "existing"` for an identical live replay. |
| `POST .../artifact-grants/:grantId/revoke`  | any member of either bound workspace     | Revokes the grant. Idempotent. The audience can renounce its own access this way.                               |
| `POST .../artifact-grants/:grantId/regrant` | owner or admin of the granting workspace | Restores a revoked grant at the next revision. Body carries the identity and `expectedRevision`.                |

Create and regrant bodies name `artifactId`, `audienceWorkspaceId`,
`checksumSha256`, `expiresAt` (ISO string or `null`), `grantId`, and `version`.
Regrant also requires `expectedRevision`. Unknown keys are refused. Versions and
digests must equal the artifact's canonical record. The path names the grant, so
a regrant body that names another grant is refused.

## What a caller sees

The granting workspace receives the grant's full identity: artifact, version,
digest, audience, expiry, revision, and revocation mark. The audience receives only
`grantId`, `revision`, and `revoked`. No response includes a file name, storage
location, or artifact content.

## Refusals

| Status | Code                                                   | Meaning                                                                                                                                     |
| ------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | `workspace_unavailable`                                | No principal.                                                                                                                               |
| 404    | `workspace_unavailable`                                | Not a member, lacks the role, not bound to the grant, or the workspace is inactive. Outsiders and insufficient roles are not distinguished. |
| 400    | `invalid_request`                                      | Malformed body, unknown key, or a regrant body naming another grant.                                                                        |
| 404    | `grant_artifact_unknown`                               | The artifact is not in the granting workspace.                                                                                              |
| 404    | `grant_not_registered`                                 | The grant id is unknown, or revoke or regrant targets a grant that does not exist.                                                          |
| 409    | `grant_target_divergence`                              | The version or digest differs from the artifact's canonical record. Nothing is persisted.                                                   |
| 409    | `grant_identity_conflict`                              | A registered grant id presented with a different identity. Never a relabel.                                                                 |
| 409    | `grant_revoked_retry`                                  | Replaying a revoked grant. Access is restored only by regrant.                                                                              |
| 409    | `grant_revision_conflict`                              | Stale or wrong `expectedRevision`. Nothing changes.                                                                                         |
| 409    | `grant_artifact_deleted`, `grant_artifact_quarantined` | The artifact is not live.                                                                                                                   |
| 409    | `grant_artifact_retention_fenced`                      | The artifact's deletion is authorized or evidenced (see the retention guide). Create, replay, and regrant change nothing.                   |

## Consumers

Job outbound publication (`job-outbound-*`) reads grant rows and applies its own
revision and revocation checks. Only the store writes those rows, and the routes add
no other write path.

- **Publication** is judged twice inside its authorization scope: once before the
  write and once after the write seam, on fresh reads and a fresh clock. A grant that
  lapses while the write waits holds the publication. The Task still completes.
- **Visibility** (`readerVisiblePublicationIds`) runs in one transaction. It takes
  share locks on the publication messages, then on the artifacts and grants, in that
  order, and holds them until the decision. A revocation that commits later waits for
  the read, so a read that returns visible is ordered before the revocation. The
  reader issues a fixed number of statements, not one per publication.
- **Replayed completions** return the outcome of the first write. Their
  `outboundPublication` carries the original decision and message id. That response
  describes the write, not current visibility. Visibility and release are decided at
  each read and release against the current grant, so a replay after revocation
  writes nothing new and releases nothing.
- Message history, direct ContentRef reads, and encrypted replica access apply the
  same current publication and thread visibility. A historical completion response
  does not restore access to its ContentRefs or replicas.

Message-bound ContentRef reads, replica listing, and replica writes hold shared locks
on the current channel and participant row through their visibility decision. Roster
replacement takes the channel lock before deleting or inserting participant rows,
keeping these operations in channel-then-roster order.

Client caches are not invalidated by a revocation. Cross-workspace invalidation is a
separate feature, and no UI change is part of this slice.

## Memory-derived results

A completion's `outboundResult` may declare `memorySource`: `none` (the default),
`workspace`, `private`, or `unknown`. A value outside that set refuses the request
before the Task completes. Any value but `none` holds the publication at the
`provenance` gate, with `memory_private_context` for `private` and
`memory_derived_unreleased` for the others. The Task still completes, nothing is
written, linked, counted or announced, and an artifact does not rescue the summary.
The hold sits after the result, job and source-access checks, so a caller who lacks
source authority learns nothing from it, and before the destination and artifact
checks, so the reason never reflects the audience's access.

The product cannot inspect a summary for memory. It enforces what the producer
declares, and the declaration is part of the completion's identity: a retry under the
same key with a different `memorySource` conflicts. An omitted field and `none` are the
same request. No memory-share grant exists yet, so there is no authority to release
workspace or private memory across workspaces (REQ 041, 054, 072); a release path needs
that contract first.

## References to separately owned jobs

A cross-workspace plan cites a job it does not own by id. `resolveJobReferences`
(`packages/db/src/job-outbound-reference.ts`) answers, for one reader and one group
channel, whether each cited job has a result currently released to that reader, and
which message carries it. Every view carries `authority: 'none'`: it lets nobody read,
change, depend on, cancel or complete the job, and it carries none of the job's title,
objective, state, workspace, project, Agent or runtime.

"Released" is the canonical delivery decision, made by the same batch gate as history,
search, counts and events (`readerVisiblePublicationIds`). The resolver adds no rule.
Every other case reads as `unavailable`, and the cases are not told apart: an unknown or
malformed id, a job that has not completed or published, a result held for memory or a
grant, a publication in another channel, a revoked grant, a reader who left the group,
a lost source authority. One resolution cites at most 50 jobs and refuses more. The
reads run in one transaction that holds the publication, artifact and grant locks to the
decision, so a revocation or roster change that commits after the read orders after it.

Task dependencies stay workspace-scoped: a plan step in the audience workspace cannot
depend on the cited job.

A group channel also holds back history from before the reader joined: a publication
earlier than the reader's join point reads as `unavailable` unless a sharing grant
releases that history, the same rule the channel's message history applies.

## Coordination plans

Adea owns the coordination plan (`packages/db/src/coordination-plans.ts`), scoped to one
group channel and its workspace. The Control Plane keeps execution plans and runtime
authority. A plan revision is an ordered, deduplicated list of at most 50 job ids and
nothing else: no title, summary, private context or credential. `job_id` is not a foreign
key to tasks, so a citation neither moves the job nor constrains it.

| Route (under `/api/v1/workspaces/:workspaceId/channels/:channelId`) | Purpose                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `POST /plans` with `Idempotency-Key` and `{ jobIds }`               | Create a plan at revision 1 (201).                                              |
| `POST /plans/:planId/revisions` with `{ expectedRevision, jobIds }` | Write revision `expectedRevision + 1` (201); a stale writer gets 409.           |
| `GET /plans/:planId/revisions/:revision/job-references`             | `{ planId, revision, references }` for the caller, from `resolveJobReferences`. |

- **Writers.** The actor is the authenticated principal. A write needs the same standing
  as posting a message to the group (workspace membership, project write access, a live
  participation grant under the channel lock). A citation that is new to a plan must
  already be released to that actor in this channel, checked in the write transaction
  with the publication and grant locks held to commit. A citation carried over from the
  previous revision is not rechecked: it is only a pointer, and each reader's resolution
  decides what it shows.
- **Revisions.** They increase by one and are immutable: triggers in migration 0056 refuse
  any update or delete of a revision or its citations, and only allow the plan row to move
  to the next revision.
- **Summaries.** The summary of a cited job is the authorized outbound publication message
  (`messageId`). The plan stores no second summary, and model-generated text is never
  approval. Message content stays behind the message read path, which checks current
  readership on its own. Memory-derived results stay held (see above), so they cannot be
  cited.
- **Reads.** The reader needs current read access to the channel. Historical revisions are
  read with current authority, so revocation, roster changes and the reader's join point
  apply to old revisions as to new ones. Hidden, revoked, unknown and unpublished
  references are one `unavailable` view, and a missing plan, revision or channel is one
  unavailable response. Responses are `Cache-Control: private, no-store`.

## Not in this slice

- A read route for grant state.
- Changes to an existing grant's expiry. A new lifetime needs a new grant id.
- Interface work for issuing or revoking grants.
- Interface work for plans, a route to list plans or read a plan's metadata, and plan
  events or notifications. Plans emit none, so no notification can carry job context.
- A memory-share grant, and with it any release of memory-derived text across workspaces.
- Producer attestation of `memorySource`. A producer that declares nothing is read as `none`.
