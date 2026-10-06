# Spec: workspace events and realtime delivery

How durable product state reaches clients: the event log, the authenticated
stream, and the client that turns events into cache refreshes. This page is the
contract to read before touching `packages/db/src/event-contract.ts`,
`event-log.ts`, `transactions.ts`, `apps/web/src/server/{event-cursor,workspace-event-stream}.ts`,
the workspace events route, or `packages/data/src/events.ts`.

**Changelog discipline:** a change to the behaviour described here lands in the
same commit as the update to this page (see `.github/CONTRIBUTING.md`).

**Projects, not rooms:** [ADR 0011](../decisions/0011-unified-workspace-projects.md)
renamed the cloud room entity to projects in one migration (`0030`). The
`project` family (`project.created`, `project.updated`, `project.archived`,
`project.reordered`, `project.deleted`) replaced `room.*`, `task.room_changed`
became `task.project_changed`, and `agent.room_assigned` became
`agent.project_assigned`. The `room` aggregate type survives in the database
enum only so historical rows stay readable; no current contract emits it, and a
client that replays an old `room.*` event treats it as an unknown family and
refreshes the workspace.

**Sharing:** ADR 0012 (workspace memory, connections and sharing) made delivery
per principal. A `members` project, its channels, messages, tasks and their artifacts are visible
only to its project members plus workspace owners and admins, so the stream classifies every event
for its subscriber before framing it ([per-principal filtering](#per-principal-filtering)). New
types: `project.visibility_changed`, `project.members_changed` (aggregate `project`, payload
`actorUserId`, `projectId`, and `visibility` or `userId`), and `workspace.member_invited`,
`workspace.member_joined`, `workspace.invitation_revoked` (aggregate `workspace`, payload
`actorUserId`, `invitationId`, and the joiner's `userId`). Invitation payloads carry ids only;
`email` joined the forbidden payload keys, so an address cannot enter the log.

## The log is authoritative; delivery is not

`workspace_events` is append-only product state. Clients synchronize from it and
recall it after a disconnect; no transport is a source of truth, and no client
state is authoritative. Channel/Message rows plus ContentRef/ContentReplica
state remain the canonical conversation history — the event log says _what
changed_, never the body of a conversation.

**Per-workspace sequence.** Every event carries `workspace_sequence`, allocated
inside the caller's transaction from the `workspace_event_sequences` counter row
(an upsert that takes a row lock). Concurrent writers to one workspace serialize
and receive distinct ordered sequences; a rolled-back mutation releases its
increment with the rest of the transaction, so committed events have no gaps a
client could read as missing work. `(workspace_id, workspace_sequence)` is
unique, and the sequence is positive by check constraint.

**One publication path.** `appendWorkspaceEvent(transaction, { workspaceId,
eventType, payload })` resolves the contract, validates the payload, allocates
the sequence, inserts the event, and writes its publication record
(`workspace_event_dispatches`). Domain modules call it inside their own
transactions; none of them insert into the log directly.

## The event contract

`WORKSPACE_EVENT_CONTRACTS` registers every durable type with its payload schema
version, aggregate type, and the payload key holding the aggregate id. An
unregistered type is refused, which is how transient presentation signals —
`message.delta`, typing indicators, cursors, camera and animation frames — stay
out of durable history, and why conversation correctness never depends on
replaying a token stream.

Payloads are validated on the way in and fail closed. A payload may not carry
Message or Task body content, prompts, provider output, ciphertext, key
envelopes, credentials, signed locations or URLs, or transient token/data
streams, and it is bounded in size. Events also record the aggregate, the acting
principal (derived from the payload's `actorUserId`/`ownerUserId`), and an
optional correlation id.

## The stream

`GET /api/v1/workspaces/:workspaceId/events` returns `text/event-stream`.

- **Authorization happens before the first byte**: the subscriber is
  re-resolved and re-authorized every 30 seconds while the stream is open, so a
  removed membership (`membership-revoked`) or a revoked session or device
  (`session-revoked`) ends delivery within that window instead of at the next
  reconnect. The ending frame names which authorization changed. Denials answer
  identically for unknown and unauthorized workspaces. Both the first check and
  the recheck use `workspace.events.read` — the catalog permission for this
  surface, held by every role that can read the workspace.
- **Cursor v1** is opaque, versioned, HMAC-signed, workspace-bound, and expires.
  The key is derived from the deployment's auth cookie secret with a
  domain-separation label; without a usable secret the route refuses to sign and
  answers `resync_required`. Frames carry the cursor in `id:`, never the
  sequence.
- **Start position.** A fresh subscriber receives current state plus live events
  from the head. A cursor inside the retained window replays every missed event
  in sequence order before live delivery. A cursor outside the window, expired,
  foreign, or ahead of the head produces `resync_required` with its reason and a
  fresh cursor — never a silent gap.
- **Retention.** `pruneWorkspaceEventsBefore` drops a workspace's oldest events
  in bounded batches and cascades to their publication records. Nothing schedules
  it yet: the retained window is an operator decision (how far back a client may
  resume), and the stream already answers a cursor from before the window with
  `resync_required`.
- **Liveness.** Heartbeats every 15 seconds, `retry: 1000` guidance, bounded
  catch-up reads on a short interval (a lost wake-up loses no event), a
  deliberate 30-minute stream lifetime, and a bounded number of concurrent
  streams per workspace. That bound is per server instance: a global limit needs
  shared state.

## Per-principal filtering

The log stays one shared, ordered history per workspace; filtering happens at delivery.
`classifyWorkspaceEventsForUser` (`packages/db/src/event-visibility.ts`) takes each page the
stream is about to send — replay and live alike — and the subscriber's **current** project access,
and gives every event one of three outcomes:

- **deliver**: sent as logged. `project.reordered` is narrowed to the project ids the subscriber can
  see.
- **redacted**: the event changes what the subscriber can see but concerns a project hidden from
  them — `project.visibility_changed`, `project.members_changed`, `task.project_changed`, and agent
  events naming a hidden project. The frame keeps the type, so the client refreshes, but drops the
  payload, aggregate id, actor and correlation id.
- **withheld**: everything else that touches a hidden project. The stream sends
  `event: workspace.withheld` with `data: {"workspaceSequence": n}` and the usual signed cursor in
  `id:`. The client advances its sequence without refreshing anything and without reading the skip
  as a gap. The frame reveals only that the shared sequence advanced, which any later event would
  reveal too.

How an event maps to a project: the payload's `projectId`; the aggregate id of `project` events;
the channel's project for `channelId`; the message's channel for a `messageId` without a
`channelId`; the task's project for `taskId`; an artifact's task; and a content ref's task or
message channel. Lookups use current state, so a task moved into a hidden project is hidden in
replay too, and a removed project member stops seeing the project's history on the next page.

**Never via resync.** `resync_required` frames carry only a fresh cursor; the client then refetches
current state through the query layer, which applies the same project access. Cursors carry no
access decision.

**Membership.** If the subscriber is no longer a workspace member when a page is classified, the
stream ends with `membership-revoked` straight away rather than at the next 30-second recheck.

**Cost.** Every page that has events costs one or two indexed reads for the access scope
(membership plus the workspace's `members` projects with the subscriber's rows). When the
subscriber can see every project — owners, admins, and any workspace without hidden projects for
them — that is all. Otherwise each page adds at most four batched lookups (channels, messages,
tasks, artifacts/content refs) keyed by the ids in the page, never one query per event. Idle polls
read nothing extra.

**Client refresh.** `project.visibility_changed` and `project.members_changed` refresh the whole
workspace scope, because access to the project's channels, tasks, read state and search changes
with them. `workspace.member_*` events fall in the `workspace` family and refresh the member and
invitation queries under the workspace prefix.

## Verifying it locally

The stream's guarantees are checkable against a running host without special
tooling:

- **Replay and cursors**: bootstrap a guest, open the stream, create a Project, then
  reconnect with the cursor printed in the earlier frame's `id:` — only events
  after it are replayed.
- **Recovery**: present a cursor from another workspace, a tampered one, or one
  from before the retained window; each answers `resync_required` with its
  reason rather than a gap.
- **Revocation**: delete the workspace membership row (or the temporary session
  row) while a stream is open; the stream ends within 30 seconds with
  `membership-revoked` or `session-revoked`.
- **Cross-instance**: start a second host on the same database and secret and
  reconnect there with a cursor minted by the first; the cursor verifies and the
  missed events replay, because neither the cursor nor replay depends on
  instance state. The only per-instance state is the connection counter.

## The client

`createWorkspaceEventSubscription` consumes the stream over `fetch` plus a small
SSE parser, so cookie-authenticated web sessions and bearer-authenticated
desktop sessions share one path, and the cursor travels explicitly.

- Events apply by `workspace_sequence`; duplicates and replays are ignored and
  the cursor is persisted, so a reload resumes where the previous session
  stopped.
- Each event family maps to the query groups it changes; an unknown family
  refreshes the workspace rather than being dropped. The `workspace` family
  (including `workspace.updated`, emitted when a member changes the name, logo,
  accent or Virtual world) also refreshes the workspace list and detail
  queries, which sit outside the per-workspace key prefix. The `message`,
  `channel` and `thread` families also refresh the account summary
  (`['account', 'summary']`, see below), which sits outside that prefix too.
  The bootstrap query
  establishes the session and is never refetched by an event. Refreshes are coalesced:
  the keys a stream chunk produces are deduplicated and invalidated once per
  chunk, so a burst of events costs one refetch per group, not one per event.
- A sequence gap or `resync_required` refetches authoritative current state
  while still advancing the cursor. The client never invents missing events.
- Reconnects back off 1s→30s with jitter, reset after a stable connection, and
  never faster than the server asks.
- One subscription is mounted in the workspace navigation shell — above view
  switching — so conventional, spatial, and dev surfaces read the same query
  state without reconnecting on each surface change, and transient UI
  coordination stays in the Solid workspace store (`solid-js/store`; decision
  [0007](../decisions/0007-solid-tanstack-start.md)).

## The account summary

Only the active workspace has a stream, and leaving a workspace releases its
cached queries (`releaseWorkspaceCache`). Unread status for the other
workspaces comes from a counts-only account summary instead
([ADR 0011](../decisions/0011-unified-workspace-projects.md), "Counts-only
cross-workspace status").

- **Route.** `GET /api/v1/account/summary` resolves the caller with
  `resolveWorkspacePrincipal` and answers `{ workspaces: [{ workspaceId,
unreadChannels, mentions }] }` with `cache-control: private, no-store`. No
  workspace permission is checked: `accountWorkspaceSummaries` starts from the
  caller's own memberships, so a workspace they do not belong to never
  appears, and archived (soft-deleted) workspaces are left out. Rows follow the
  member's own workspace order. Nothing in the payload names a channel,
  message, or person.
- **One grouped query.** Channel visibility matches read state: active
  channels that are workspace-visible or list the caller as a participant.
  `unreadChannels` counts those whose `channels.latest_message_sequence` is
  past `channel_read_states.last_read_sequence` (missing state reads as 0), or
  that are marked `manually_unread`. Thread-only replies do not make a channel
  unread here; the in-workspace read state still counts them. `mentions`
  counts live, unread top-level messages in those channels that mention the
  caller (`message_mentions`, indexed by `message_mentions_user_idx`).
- **The frontier column.** `channels.latest_message_sequence` (migration
  `0031`) is the newest live top-level message sequence, 0 when there is none.
  `createMessage` advances it with `GREATEST` in the insert transaction, so
  out-of-order commits never move it back; a thread reply leaves it alone.
  `deleteMessage` of the current newest top-level message moves it back to the
  newest remaining live one, in the delete transaction; deleting an older
  message leaves it. It is not part of the channel `version` and does not
  touch `updated_at`.
- **Client.** `accountSummary()` in `/api-client`; `useAccountSummaryQuery`
  in `/data` polls every 60 seconds and on window focus, under
  `['account', 'summary']`, which a workspace switch keeps. The active stream's
  `message`, `channel` and `thread` families and the read-state mutations
  invalidate it, so the active workspace is current immediately and the others
  within a minute.

## Pinned by

- `packages/db/tests/integration/workspace-events.test.ts`: atomicity with the
  domain mutation, rollback with no sequence gap, concurrent writers,
  replay/cursor behavior, cross-workspace isolation, retention, a lost wake-up,
  redaction and oversize refusal, conversation create/update/delete events,
  artifact availability, and two clients converging on the same history.
- `packages/db/tests/integration/sharing.test.ts`: per-principal classification
  (withheld, redacted, narrowed reorder) for outsiders, viewers, editors, admins
  and owners, replay after removal, and the end of delivery for non-members.
- `apps/web/test/event-stream.test.ts`: cursor round-trip and every rejection
  reason, wire frames and their exact field set, the withheld frame, the
  replay decision table, the
  revalidation outcome (allowed, session-revoked, membership-revoked), and
  stream-connection accounting.
- `packages/data/tests/unit/events.test.ts`: frame parsing, family-to-query
  mapping, withheld frames advancing without a gap, backoff, apply-once semantics with cursor persistence, gap and resync
  recovery, and the server-retry floor.
- `packages/db/tests/integration/account-summary.test.ts`: the frontier on
  insert, thread reply, idempotent retry and delete; counts across three
  member workspaces in exactly one query; a non-member workspace never
  appearing; private-channel visibility and participant removal; read marks
  and manual unread; archived workspaces dropping out.
- `packages/data/tests/unit/account-summary.test.ts` and `events.test.ts`:
  the summary's key, polling and focus refetch, its invalidation by the
  unread-changing families and read-state mutations, and its survival of
  `releaseWorkspaceCache`.
- `apps/web/test/start-client-denylist.json`: the server stream modules cannot
  appear in a browser bundle.
