# Group audience and participation UI

The new-group and manage-group dialogs live in `packages/workspace-ui/src/group-audience.tsx` (view) and
`group-audience-model.ts` (pure rules). They are loaded only through `create-workspace-dialogs.tsx`, so they stay
one lazy chunk; the group header opens the manage dialog from there on demand. The new-group dialog is mounted
through `ConnectedCreateGroupDialog`, which reads the workspace's members and workspaces only while it is open.

## What the person sees

- The creator is listed first. Everyone else comes from the tenant: workspace members and active Agents, each
  with a stable qualified identity (`user:<id>`, `agent:<id>`). Agents with the same display name are always shown
  as "Name · Workspace", with a short id only when that still collides.
- The group header lists the people the server holds for the group. It never assumes a "You" roster.
- Joining grants join-point history only. Earlier native history, summaries or sharing need explicit,
  audience-aware authorization, which this UI does not grant.
- Removing someone revokes their future reads and turns. It does not cancel jobs they own or erase retained records.

## Authority

The client never mints grants and never derives them from ids or names. It sends a **selection**: human user ids
and Agents as `{agentId, workspaceId}` pairs (`POST .../channels` with `selection`, and `POST .../participants`
with `selection` for a group). Grants, revisions and windows are issued by `packages/db/src/group-grant-issuer.ts`
inside the same transaction that writes the roster. A body that carries `audienceGrants`, `enlistmentGrants` or a
`participants` list for a group is refused with 400.

- First issuance uses a deterministic grant id at revision 1 (`audience:<userId>`,
  `enlistment:<agentWorkspaceId>:<agentId>`), so a retried create hashes to the same payload and replays to the
  same group.
- A member who is on the roster keeps the exact grant their admission is bound to, so jobs bound to it are
  untouched and their history frontier stays. If that grant has since been revoked or has expired, keeping them
  is refused with `grant_revoked`/`grant_expired` reasons (shown against their row) and nothing is renewed:
  a stale draft that still lists them cannot bring them back.
- Readmission is explicit: remove the person, then add them again. A person who is not on the roster always gets
  the next revision of their grant, so nothing bound to an earlier admission (for example a child job that
  finished while they were removed) matches the new one, and the new admission starts at a fresh history
  frontier. What was said while their access was withdrawn or while they were out stays hidden from them.
  Any admission whose grant id or revision changes gets a fresh frontier in the store as well.
- Issuing a grant confers nothing by itself. The unchanged store checks still prove, in the transaction, that each
  person holds a live host-workspace membership, that each Agent is active and that its source workspace
  authorizes the acting principal, and that roster replace comes from an owner or admin at the version seen.
  Anything else is refused with the policy's typed reasons (`group_grant_rejected`) or the uniform 404.

## Failure handling

## Failure handling

- Create attempts keep `channelId` and `idempotencyKey` while the payload is unchanged, so a lost response is
  retried to the same group and a double submit sends once. A changed payload starts a new attempt.
- Selections and the title survive every recoverable error. A group is shown as created only from the server answer.
- Roster saves send `expectedVersion`. A stale answer keeps the draft, re-bases it onto the fresh roster and asks
  for a review before saving again.
- Every host passes `scope` (account, workspace, audience epoch) to the new-group dialog, with or without audience
  lists. A change in scope, or in the account, workspace or group of the manage dialog, clears the whole draft
  (title included) and drops the attempt. Each send is fenced by a generation: an answer that arrives after
  the screen has changed (even if it changed and changed back) is not shown, and cannot restore the reset attempt.
- Closing or unmounting either dialog invalidates its generation too, so an answer that arrives after the dialog
  was closed (or closed and reopened) is not shown as that screen's result.
- A roster save whose outcome is unknown does not claim a retry is "the same request": a retry is checked against
  the group's current version. The host is asked to re-read the
  group, so a save that did land shows up as a change to review; a conflict right after such a save says the
  earlier save may be what changed it.
- Switching account or workspace clears drafts. 401, 403, 404 and revoked access in the manage dialog end in the
  uniform "unavailable" message and hide the group's title, roster, choices and draft. `group_grant_rejected` keeps the form and shows the per-identity reasons.

## Not covered (backend gaps)

- A tenant-authorized list of Agents from other workspaces. The server accepts a qualified Agent from another
  workspace when the acting principal is an owner or admin there, but the dialogs can only offer the Agents the
  host already lists, and a roster member whose Agent workspace is unknown to the screen cannot be retained from
  it (the save is blocked with a message instead of guessing a workspace).
- A read model for each member's standing (grant state, join point), so "joined at" and "access ends" cannot be shown.
- HTTP routes to revoke grants or share earlier history or summaries.
- Cross-device private-history sync (#193) stays deferred.
