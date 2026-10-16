# Group audience and participation UI

The new-group and manage-group dialogs live in `packages/workspace-ui/src/group-audience.tsx` (view) and
`group-audience-model.ts` (pure rules). They are loaded only through `create-workspace-dialogs.tsx`, so they stay
one lazy chunk; the group header opens the manage dialog from there on demand.

## What the person sees

- The creator is listed first. Everyone else comes from the tenant: workspace members and active Agents, each
  with a stable qualified identity (`user:<id>`, `agent:<id>`). Agents with the same display name are always shown
  as "Name · Workspace", with a short id only when that still collides.
- The group header lists the people the server holds for the group. It never assumes a "You" roster.
- Joining grants join-point history only. Earlier native history, summaries or sharing need explicit,
  audience-aware authorization, which this UI does not grant.
- Removing someone revokes their future reads and turns. It does not cancel jobs they own or erase retained records.

## Authority

The client never mints grants and never derives them from ids or names. Grants come from a `GroupGrantIssuer`
passed in as `audience.issueGrants`; the UI sends the issuer identities only, checks that what comes back matches
the request exactly, and forwards it. The server stays decisive: the roster shown after a save is the server's
returned group. No trusted issuer exists yet, so today:

- creating a group starts with the creator only, with a note that nobody else can be requested from here yet;
- the manage dialog is read-only and names the missing dependency.

## Failure handling

- Create attempts keep `channelId` and `idempotencyKey` while the payload is unchanged, so a lost response is
  retried to the same group and a double submit sends once. A changed payload starts a new attempt.
- Selections and the title survive every recoverable error. A group is shown as created only from the server answer.
- Roster saves send `expectedVersion`. A stale answer keeps the draft, re-bases it onto the fresh roster and asks
  for a review before saving again.
- Every host passes `scope` (account, workspace, audience epoch) to the new-group dialog whether or not an issuer
  exists. A change in scope, or in the account, workspace or group of the manage dialog, clears the whole draft
  (title included) and drops the attempt. Each send is fenced by a generation: after the issuer answers, a send
  that finds the screen has changed (even if it changed and changed back) stops before anything is created or
  saved, and cannot restore the reset attempt.
- Switching account or workspace clears drafts. 404 and revoked access end in the uniform "unavailable" message
  with nothing from the group shown. `group_grant_rejected` keeps the form and shows the per-identity reasons.

## Not covered (backend gaps)

- A trusted grant issuer / selection endpoint. The routes accept caller-authored grants.
- A read model for each member's standing (grant state, join point), so "joined at" and "access ends" cannot be shown.
- HTTP routes to revoke grants or share earlier history or summaries.
- A tenant-authorized list of Agents from other workspaces.
- The participants route compares Agents with the host workspace, so groups holding foreign-workspace Agents may
  not be editable (suspected, not verified).
- A roster replace needs fresh grants for every retained member.
