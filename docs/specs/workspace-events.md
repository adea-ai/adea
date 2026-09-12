# Spec: workspace events and realtime delivery

How durable product state reaches clients: the event log, the authenticated
stream, and the client that turns events into cache refreshes. This page is the
contract to read before touching `packages/db/src/event-contract.ts`,
`event-log.ts`, `transactions.ts`, `apps/web/src/server/{event-cursor,workspace-event-stream}.ts`,
the workspace events route, or `packages/data/src/events.ts`.

**Changelog discipline:** a change to the behaviour described here lands in the
same commit as the update to this page (see `.github/CONTRIBUTING.md`).

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
  identically for unknown and unauthorized workspaces.
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

## Verifying it locally

The stream's guarantees are checkable against a running host without special
tooling:

- **Replay and cursors**: bootstrap a guest, open the stream, create a Room, then
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
  refreshes the workspace rather than being dropped.
- A sequence gap or `resync_required` refetches authoritative current state
  while still advancing the cursor. The client never invents missing events.
- Reconnects back off 1s→30s with jitter, reset after a stable connection, and
  never faster than the server asks.
- One subscription is mounted in the shared workspace controller, so
  conventional and spatial surfaces read the same query state, and transient UI
  coordination stays in Zustand.

## Pinned by

- `packages/db/tests/integration/workspace-events.test.ts`: atomicity with the
  domain mutation, rollback with no sequence gap, concurrent writers,
  replay/cursor behavior, cross-workspace isolation, retention, a lost wake-up,
  redaction and oversize refusal, conversation create/update/delete events,
  artifact availability, and two clients converging on the same history.
- `apps/web/test/event-stream.test.ts`: cursor round-trip and every rejection
  reason, wire frames and their exact field set, the replay decision table, the
  revalidation outcome (allowed, session-revoked, membership-revoked), and
  stream-connection accounting.
- `packages/data/tests/unit/events.test.ts`: frame parsing, family-to-query
  mapping, backoff, apply-once semantics with cursor persistence, gap and resync
  recovery, and the server-retry floor.
- `apps/web/test/start-client-denylist.json`: the server stream modules cannot
  appear in a browser bundle.
