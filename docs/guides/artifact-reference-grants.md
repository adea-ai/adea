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

Client caches are not invalidated by a revocation. Cross-workspace invalidation is a
separate feature, and no UI change is part of this slice.

## Not in this slice

- A read route for grant state.
- Changes to an existing grant's expiry. A new lifetime needs a new grant id.
- Interface work for issuing or revoking grants.
