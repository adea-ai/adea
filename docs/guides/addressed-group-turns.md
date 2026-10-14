# Addressed group turns

How a human addresses an Agent in a group channel, how that request survives retries and reconnects, and
where the guarantees end. The durable store and its rules live in `packages/db/src/group-turn-coordinator.ts`;
the product surface is `packages/db/src/group-turn-product.ts` and the handlers in
`apps/web/src/server/addressed-turn-routes.ts`. Tracked by adea-ai/adea#1179 (M15.02), which stays open.

## API

All three routes are workspace-scoped, require a resolved principal, and answer `404` for anyone who cannot
read the group now (never admitted, revoked, expired, other workspace, unknown group).

| Route                                                                       | Purpose                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `POST /api/v1/workspaces/:workspaceId/channels/:channelId/turns`            | Address an Agent from a human message; persist, then dispatch.          |
| `GET  /api/v1/workspaces/:workspaceId/channels/:channelId/turns`            | Reconnect and replay read, in committed order, with `after` and `limit` |
| `POST /api/v1/workspaces/:workspaceId/channels/:channelId/turns/:id/cancel` | Cancel one turn (the addresser or a workspace manager).                 |

The request body is exactly `{ triggerMessageId, agentId, dispatchRevision, parentTurnId? }`. The addresser is
always the authenticated principal and the budget is always the coordinator's own; a body that names either, or
anything else, is refused with `400`.

## What is persisted before dispatch

One row per `(triggerMessageId, agentId, dispatchRevision)` in `app.addressed_agent_turns`, written in the claim
transaction before any dispatch: the causal ID (`turn:<trigger>:<agent>:<revision>`), the workspace-qualified
recipient label, the revision, the depth, the turn budget (default depth 2, 8 turns per trigger tree), and the
addresser's attribution. A retry or a reconnect re-submitting the same triple converges on that row (`200`
instead of `201`), including when the budget is full.

## Authority is re-proved on every call

The handler gate runs first. The coordinator then re-proves, inside its own transaction, that the trigger is a
real human-authored message in this channel, that the principal wrote it (or manages the workspace), that the
principal holds a live audience grant, and that the Agent holds a live enlistment. A duplicate is returned only
after the same proof. Failures of authority or binding all answer `404`, so a caller learns nothing about turns,
Agents or revoked grants. States reached only after that proof answer `409` with `code: "turn_conflict"` and a
`reason`: `turn_superseded`, `turn_cancelled`, `turn_already_responded`, `turn_budget_exhausted`,
`turn_depth_exceeded`.

Cancel takes no input. An absent body is the normal request; a body that is oversized, claims an invalid length or
fails mid-read answers `400` before the coordinator is reached, so a failed read can never cancel a turn.

## Ordering, human priority, loops

- Replay is ordered by commit time and id. A turn whose trigger message the reader cannot read (it predates their
  join point and no sharing grant covers it) is omitted entirely, and its id is not a valid cursor for that reader.
  Only that deliberate "unavailable" outcome omits a turn. A database or infrastructure failure while checking a
  trigger fails the whole read (`503`, `code: "turns_read_failed"`, retryable), so a page is never silently short
  and a paging client cannot move its cursor past a turn it never saw.
- A newer human message in the group supersedes every live turn in the same transaction as the post. Agent
  messages never supersede and never address.
- Only a human message can trigger a turn, so Agent output cannot start follow-up turns on its own.

## One response per message, Agent and revision

Dispatch admits a lead-turn intent bound to the original trigger message (no synthetic message). When the lead
runtime publishes the Agent's answer, the same publication transaction binds that message to the claim whose
intent it is and moves the claim to `responded`; a replayed publication repairs a binding an interrupted attempt
missed. A superseded or cancelled turn keeps that state, and the published message stays ordinary channel history.

## Client

The group conversation addresses Agents through `packages/data/src/addressed-turns.ts` (queries, mutations and
the convergence ledger) and `packages/workspace-ui/src/group-addressing.tsx` (the surface). The pure rules are in
`packages/workspace-ui/src/addressed-turn-model.ts`.

- **Identity, never names.** The recipient picker lists the group's Agents as `Name · Workspace` and sends the
  chosen Agent IDs as the message's mentions and as the address requests. A same-named Agent from another
  workspace is a different row. An Agent this client cannot resolve reads `Agent <short id> · <workspace>`; the
  home workspace is learned from the server-bound label on a retained turn. Nothing is addressed unless a
  recipient is chosen, and the choice stays until it is changed; the header says so (`Next message: …`).
- **Addressing mode and audience.** The group header shows the audience (`Participants only` / `Whole workspace`)
  and the next message's mode (`No Agent addressed`, `Addressing <Agent>`, `Addressing N Agents`).
- **Committed order.** Under each human message the Agents it addressed are listed in the order the server
  committed them (`1 of 2`, `2 of 2`) with the server's state: `Admitted`, `Dispatched`, `Answered`, `Superseded`,
  `Cancelled`. The UI shows only server-confirmed state. A claim for a non-lead Agent reads `Not started`
  and says that only the group's lead runs turns today; it is never shown as running.
- **Cancellation.** `Cancel turn` is offered only while the turn is live. The row changes when the server
  confirms; repeating it is harmless because cancel is idempotent. A `409` shows the reason's own copy; a `404`
  discloses nothing beyond "no longer available to you".
- **Duplicates and reconnects.** Address requests are keyed on (message, Agent, revision 1), the same key the
  server collapses on, so a lost response is retried unchanged (button, or automatically when the browser comes
  back online) and never starts a second turn. Each turn is folded into the cache by its causal ID with a
  monotonic state rank, so a late or repeated delivery never moves a turn backwards. A complete replay (paged to
  a cap of 25 pages) is authoritative for listing and order: a turn the cache held when the read began and the
  replay omits is dropped, an empty replay included, so withdrawn history does not linger. Only a turn folded in
  while that read was running survives it (it may have committed after the server answered); the next read
  settles it. A failed refresh keeps the turns last read for the same audience, with their Cancel buttons, and
  shows `Addressed turns could not be refreshed` with Retry (a 429, 5xx or dropped connection says nothing about access); a replaced audience never shows them. A 401, 403 or the uniform 404 says access is gone: the held turns are cleared and `Addressed turns are no longer available to you, so none are shown.` appears with `Read again`, even when the revocation event has not arrived. An incomplete
  read keeps what was shown and offers `Read again`. Replays refetch every 3 seconds
  only while a turn is live, when the conversation's latest message changes, and on reconnect.
- **Message retries.** The recipients are part of the message's submission identity, because a group message's
  mentions are its recipients and the message route refuses a reused idempotency key with a different payload. A
  retry with the same recipients keeps its key and converges on the committed message; changing recipients after
  a lost response is a changed submission and sends as a new message, as an edited body does.
- **Proof.** `apps/web/test/integration/addressed-turn-client-convergence.test.ts` drives the real client, the
  real route handlers and the database (concurrent tabs, a lost response, reconnect order, a stale replay after
  cancel, supersede with a stale retry, a revoked reader). `apps/web/e2e/group-addressing.spec.ts` covers what the
  browser shows.

## Not covered

- Only the group's currently resolved lead is dispatched. Addressing any other enlisted Agent keeps the claim
  (`dispatch: "not_lead"`) and starts nothing; per-Agent runtime execution is not built.
- The client cannot tell a lead from a non-lead before addressing: the server's `dispatch` answer is the only
  source, so `Not started` is stated generically and the picker offers every Agent in the group.
- The recipient choice is kept in the open conversation only; it is not persisted across reloads.
- Cancelling a turn requests runtime cancellation only for the addresser who owns the intent, and only when an
  executor currently holds it (`runtimeCancelRequested`).
- Reconnected execution resumption is not part of this slice.
- Replay reads bounded windows in `(created_at, id)` order and scans at most 1,000 rows for one page. If unreadable
  turns prevent a complete page within that limit, the read returns retryable `503` (`turns_read_failed`) rather
  than advancing past them. The current `addressed_agent_turns_channel_idx` covers `(workspace_id, channel_id)`
  but omits `(created_at, id)`, so PostgreSQL may still sort all rows for a channel. A future migration should add
  an index on `(workspace_id, channel_id, created_at, id)` for the bounded ordered read path.
