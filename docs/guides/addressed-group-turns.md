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

## Ordering, human priority, loops

- Replay is ordered by commit time and id. A turn whose trigger message the reader cannot read (it predates their
  join point and no sharing grant covers it) is omitted entirely, and its id is not a valid cursor for that reader.
- A newer human message in the group supersedes every live turn in the same transaction as the post. Agent
  messages never supersede and never address.
- Only a human message can trigger a turn, so Agent output cannot start follow-up turns on its own.

## One response per message, Agent and revision

Dispatch admits a lead-turn intent bound to the original trigger message (no synthetic message). When the lead
runtime publishes the Agent's answer, the same publication transaction binds that message to the claim whose
intent it is and moves the claim to `responded`; a replayed publication repairs a binding an interrupted attempt
missed. A superseded or cancelled turn keeps that state, and the published message stays ordinary channel history.

## Not covered

- Only the group's currently resolved lead is dispatched. Addressing any other enlisted Agent keeps the claim
  (`dispatch: "not_lead"`) and starts nothing; per-Agent runtime execution is not built.
- Cancelling a turn requests runtime cancellation only for the addresser who owns the intent, and only when an
  executor currently holds it (`runtimeCancelRequested`).
- Reconnected execution resumption and a client UI for addressing are not part of this slice.
- Replay loads the channel's turns and filters per trigger message; it is bounded by the turn budget per trigger
  tree but is not indexed for very large histories.
