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
`project.reordered`, `project.restored`, `project.deleted`) replaced `room.*`,
`task.room_changed` became `task.project_changed`, and `agent.room_assigned`
became `agent.project_assigned`. Explicit project-state promotion appends
`project.restored` and wakes every archived project channel with
`channel.restored` (aggregate `channel`, payload `actorUserId`, `channelId`,
`projectId`; ids only, like `channel.archived`). The `room` aggregate type
survives in the database enum only so historical rows stay readable; no
current contract emits it, and a client that replays an old `room.*` event
treats it as an unknown family and refreshes the workspace.

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

### Explicit Agent profile changes

Structural workspace-lead provisioning emits the existing `agent.created` event exactly
once, in the identity transaction. Concurrent retries return the same Agent without a
second event or model call. Lead designation, a missing structural profile, provider
authentication and execution acceptance remain separate state. New direct topics use the
same `channel.created` event; they preserve the canonical channel audience rather than
copying a previous conversation's messages or participants.

Explicit `leadTurn: true` message admission commits the ordinary `message.created`
event, canonical message and a server-owned blocked dispatch intent in one transaction.
Failure rolls all three back; retries retain the same message/intent and do not append
another event. The UUID intent pins lead/profile/channel/audience references without
copying message bodies or model credentials. A saved message event proves persistence;
it does not prove runtime acceptance, dispatch or public child outcome delivery.
Ordinary direct project/session message writes create no lead intent.

Preparation separately retains exact canonical execution, attempt and selection pins;
it does not start inference or mint a second session store. An explicit start requires
the prepared funding confirmation and current authority. Status/progress reads and
recovery never imply a start. Runtime progress is a bounded metadata projection rather
than a durable token stream. Completed output publication commits its canonical Agent
message/event and idempotent publication receipt together, under locks checking the
current audience, original sender, pinned profile and runtime binding, plus a fresh
trusted publication grant. A withheld or unknown outcome remains retained without a
public append. Missing runtime composition remains unavailable.

`agent.profile_changed` schema version 2 records `actorUserId`, `agentId`,
`previousProfileId`, `previousProfileVersion`, `profileId`, `profileVersion`
and the new `profileRevision`. The reference change, revision increment and
publication record commit atomically. Profile definitions, instructions and
credential material stay out of the log. Version 1 events remain historical
records; the client invalidates the Agent query for either version.

Public profile adoption resolves an exact `prf_`/`pfv_` pair through the pinned
SDK catalog and `profile.resolve` APIs before the mutation. Adea does not pick
latest versions or compile profile/Skill policy. The database rechecks an
owner/admin membership while holding its row, and serializes Agent changes
with a row lock and expected revision. The opening form snapshot survives
refetches: stale edits return a conflict instead of replacing another pin.
The additive `profile_revision` column starts existing rows at zero.

This increment establishes explicit pin adoption only. Submission must still
snapshot the pin in its own transaction and record the immutable ExecutionPlan
and Skill manifest actually used; changing an Agent is never proof of a running
execution's configuration or current compatibility.

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
stream is about to send — replay and live alike — and the subscriber's **current** project and channel access,
and gives every event one of four outcomes:

- **deliver**: sent as logged. `project.reordered` is narrowed to the project ids the subscriber can
  see.
- **redacted**: the event changes what the subscriber can see but concerns a project hidden from
  them — `project.visibility_changed`, `project.members_changed`, `task.project_changed`, and agent
  events naming a hidden project. The frame keeps the type, so the client refreshes, but drops the
  payload, aggregate id, actor and correlation id.
- **audience_changed**: a version-2 `channel.updated` records a change from workspace visibility
  to participant visibility and current channel access denies the subscriber. If its project is
  still visible, the stream sends `event: workspace.audience_changed` with only
  `data: {"workspaceSequence": n}` and the signed cursor. No channel, actor or content identity
  travels. Private-from-creation channels and transitions in hidden projects remain withheld.
  The client cancels pending queries and erases resident workspace and account data before
  refetching. It clears channel/thread selection and invalidates retained transcript generations;
  late query or mutation responses cannot restore the cleared conversation cache. Direct runtime
  session selection and other workspaces retain their own authority.
- **withheld**: everything else that touches a hidden project, a participant-only channel whose
  current audience excludes the subscriber, or a missing/foreign referenced resource. The stream sends
  `event: workspace.withheld` with `data: {"workspaceSequence": n}` and the usual signed cursor in
  `id:`. The client advances its sequence without refreshing anything and without reading the skip
  as a gap. The frame reveals only that the shared sequence advanced, which any later event would
  reveal too.

How an event maps to a project: the payload's `projectId`; the aggregate id of `project` events;
the channel's project for `channelId`; the message's channel for every `messageId`, even when a
`channelId` is also present; the task's project for `taskId`; an artifact's task; and a content ref's task or
message channel. Lookups use current state, so a task moved into a hidden project is hidden in
replay too, and a removed project member stops seeing the project's history on the next page.
Channel, message, thread/reply and content references also require current channel audience access.
Workspace owners and admins retain their project privileges but cannot bypass a participant-only
channel's audience. Removing a participant therefore withholds that channel's replay events as well
as future events; archived conversation history follows the same current audience check.

**Never via resync.** `resync_required` frames carry only a fresh cursor; the client then refetches
current state through the query layer, which applies the same project and channel access. Cursors carry no
access decision.

**Membership.** If the subscriber is no longer a workspace member when a page is classified, the
stream ends with `membership-revoked` straight away rather than at the next 30-second recheck.

**Cost.** Every page that has events costs one or two indexed reads for the access scope
(membership plus the workspace's `members` projects with the subscriber's rows). Each page adds at
most five batched reference lookups (channels, messages, tasks, artifacts, content refs) keyed by
the ids in the page, never one query per event. Channel audience checks use indexed participant
existence projections in those lookups, including for owners and admins. A page containing only
project events needs only the access-scope reads. Idle polls
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
- `runtime_node` events refresh the registered-host and connection-discovery
  group under `['workspaces', workspaceId, 'runtime-nodes']`. They do not imply
  execution acceptance or change canonical Message/history availability.
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
  touch `updated_at`. In-workspace read state (`listReadStateForUser`) reads
  it as `latestTopLevelSequence` and counts top-level unread messages only
  when it is past the read frontier, so both surfaces share one frontier.
- **Client.** `accountSummary()` in `/api-client`; `useAccountSummaryQuery`
  in `/data` polls every 60 seconds and on window focus, under
  `['account', 'summary']`, which a workspace switch keeps. The active stream's
  `message`, `channel` and `thread` families and the read-state mutations
  invalidate it, so the active workspace is current immediately and the others
  within a minute.

## Task delivery intent events

`task.submission_queued` is a version-1 Task event. Its payload names the Task,
submission, request, selected node, actor and delivery-intent state. Admission
appends it in the same transaction as the intent row and command outbox record;
it contains neither ciphertext nor prompt/context bodies, and grants no runtime
acceptance or Task lifecycle transition. The rollback and duplicate-admission
cases in `packages/db/tests/integration/task-submissions.test.ts` pin this boundary.

## Control Plane execution event privacy boundary

`apps/web/src/server/control-plane-events.ts` decodes the pinned public
`AgentHqExecutionEventEnvelopeSchema` from `@adea-ai/contracts` 1.14.0. This is
a prerequisite for #39's inbox, not the inbox or an authenticated delivery
endpoint. Raw Control Plane events are never WorkspaceEvents or Messages.

The encoded envelope is capped at 24 KiB before UTF-8 decoding. Structural
preflight refuses `__proto__` keys and caps depth at 16 and visited values at 512 before the public recursive
JSON schema or canonical hasher runs. Source data is capped at 16 KiB and the
final projection at 8 KiB. Unexpected envelope/correlation fields, unsupported
event names, contract majors other than 1, and payload schema versions other
than 1 are refused. Additive contract minors use the same explicit projection.
Sequence and count metadata must remain safe integers; timestamps are bounded.

The caller supplies an independently resolved workspace/project/Task/Agent/
execution scope. Every corresponding public identifier must match. The source
payload SHA-256 is verified using the public canonical JSON serializer before
private fields are removed; `projectionHash` covers only the retained `data`,
not the envelope headers. Neither data hash identifies a complete event. Future
inbox deduplication must also compare the qualified event identity and its
coordination headers. Both hashes are metadata, not authorization or execution
acceptance.

The accepted `data` fields form Adea's bounded cloud projection inside the
public envelope's otherwise unrestricted JSON data:

| Field                           | Retained metadata                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `state`                         | Fixed execution-state vocabulary; a state-bearing execution/attempt type cannot contradict it |
| `availability`, `providerState` | Fixed availability classifications, never provider text                                       |
| `failure`                       | Fixed failure classification and optional retryability; no free-form code/message             |
| `progress`                      | Nonnegative safe `completed`/`total` counts, with completed no greater than total             |
| `usage`                         | Public usage counts and bounded amount/currency; no provider output                           |
| `artifactRefs`                  | At most 32 public Artifact IDs, versions, digests and sizes; no locator or media label        |

Unknown data fields are removed, including prompt/response/ContextPackage,
provider material, native paths, result locators and transcripts. Malformed
recognized metadata is refused rather than coerced. Header and usage fields
are explicitly copied, so a future public schema addition is not automatically
forwarded into persistence. The isolated projection is recursively frozen.
Errors expose only fixed reason codes and no input or schema diagnostics.

The public envelope does not carry selected host/location identity. Authenticated
delivery and retained acceptance metadata must establish that binding before
inbox admission. A caller cannot derive the expected scope from this same input.
Artifact references still need authorized resolution; no content access is
granted by decoding one. No inbox row, Task transition, Message, Artifact or
usage attribution is written by this decoder. Durable scoped deduplication,
ordering/gap handling, atomic application, replay tools and canonical Conversation
Service mapping remain required by #39.

`apps/web/test/control-plane-events.test.ts` pins the public-schema content-leak
canaries, scope/hash/schema refusals, bounded work, metadata projection and
immutability. The client bundle denylist keeps this server boundary out of
browser code. These tests require no Control Plane checkout or service.

## Pinned by

Outbound pulls emit the version-1 `runtime_node.proof_accepted` event at most
once per minute with node UUID, request UUID, signing fingerprint and explicit
actor kind `runtime_node` (migration 0038). Nonce, liveness and event commit
atomically. The log contains no signature/ciphertext or inferred user identity.
This proves liveness, never execution acceptance.

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
- `packages/db/tests/integration/event-audience.test.ts`: current channel audience and archived
  replay, ID-free visibility narrowing, and private/hidden/missing reference denial.
- `packages/data/tests/unit/events-audience.test.ts` and `mutations-audience.test.ts`: real
  QueryClient observers lose revoked data before denied refetch; cancelled late queries and
  accepted late mutations cannot repopulate it. Malformed audience frames cannot advance cursors.
  `conversation-audience-resource.test.ts` mounts the real Solid query resource and rejects an
  old successful page during its delayed resource update using the request's audience generation.
  State tests cover channel/thread reset while preserving direct sessions. Conversation surface
  audience tests pin source guards; they do not qualify mounted UI or browser behavior.
- `packages/db/tests/integration/account-summary.test.ts`: the frontier on
  insert, thread reply, idempotent retry and delete; counts across three
  member workspaces in exactly one query; a non-member workspace never
  appearing; private-channel visibility and participant removal; read marks
  and manual unread; archived workspaces dropping out.
- `packages/db/tests/integration/read-state-counts.test.ts`: in-workspace
  read state against a message-level oracle through thread reads, manual
  unread, and deletions; hidden-project channels left out; a fixed four
  queries whatever the channel count.
- `packages/data/tests/unit/account-summary.test.ts` and `events.test.ts`:
  the summary's key, polling and focus refetch, its invalidation by the
  unread-changing families and read-state mutations, and its survival of
  `releaseWorkspaceCache`.
- `apps/web/test/start-client-denylist.json`: the server stream modules cannot
  appear in a browser bundle.
