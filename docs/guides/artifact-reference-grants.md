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

## Not in this slice

- A read route for grant state.
- Changes to an existing grant's expiry. A new lifetime needs a new grant id.
- Interface work for issuing or revoking grants.
- A route or interface that calls `resolveJobReferences`, and a plan record that stores the
  cited ids. Only the read model and its guarantees are here.
- A memory-share grant, and with it any release of memory-derived text across workspaces.
- Producer attestation of `memorySource`. A producer that declares nothing is read as `none`.
