# Authorized transcript history and production prompt text (#1396)

Implementation for [#1396](https://github.com/adea-ai/adea/issues/1396), based on
main `5e0feec64`. This is source and test evidence, not packaged/native, remote
production, or rendered canvas acceptance. The issue remains open.

## Ownership and reviewed sources

Read the runtime spec, ADR 0009, exact operations registry, donor audit/source
manifest, implementation guide, M12 plan and donor event-boundary audit before
implementation. No donor implementation was copied. Existing Adea authority,
event-log and stream seams remain the authorities.

The chat canvas was inspected read-only at Adea #1385,
`ef90a8d92e3d96c8fbacbc90b127daf302770d54`, including its
`docs/evidence/chat-canvas-2026-10-15.md`. Shared UI #416 was inspected read-only
at `f74a9ee2ab03bd3a3687d43ee9a193ac2db2a05d`, specifically MessageScroller's
loader and stable-anchor contract. This branch changes neither owner's files
nor dependency pins. #1386, #1387, #1389, #1391 and #1395 remain separate owners.

Shared integration changes are limited to the operation registry/generated
metadata, one DTO export/reply decoder in `dev-runtime.ts`, and the existing
Chat model's stream handle. No migration, release, deployment, credential/access
change, check weakening, or issue closure is included.

## Working vertical slice

- `dev.session.history` is a normal authenticated command with
  `dev.session.read`, an explicit runtime-session resource and current generation.
  It rechecks all scope fields and canonical session identity before reading.
  Archived session history remains readable at its current generation.
- Backward pages return ascending events, at most 500/default 100 and 192 KiB
  encoded event content. Cursors are opaque HMACs, bound to the complete scope,
  session, generation, page size, retained floor identity and snapshot bounds.
  The owner-only cursor key is host-local pagination state, not a capability.
  It survives restart. New commands always reauthorize. Concurrent appends do
  not move a cursor; pruning its retained floor requires a fresh stream/window.
- Retained bounds and `historyStart` distinguish generation start, known
  retention loss and unavailable history. This reads the retained 1,000/session,
  5,000/scope log beyond the newest-500 stream replay; it cannot recover deleted
  history or read an earlier generation using the current generation's authority.
  Oversized single payloads are explicitly omitted while retaining sequence.
- The production ACP/PTY launch register writes filtered original-user
  `text`/`textTruncated` into a successful delivery's `turn.user_input` event.
  The 16 KiB UTF-8 projection preserves whitespace and cuts only at code-point
  boundaries. Known secret patterns, auth fields, URL credentials, private home
  paths and display controls are filtered before persistence. Pattern filtering
  is defense in depth; authenticated scope remains the authority.
- The delivered prompt stays intact. Workspace-memory text never enters the
  event projection; only its counts do. Failed delivery and legacy or memory-only
  receipts do not acquire invented text. Credential/restricted-local event
  payloads are omitted from transcript persistence/serialization. History and
  stream serialization filter stored payloads again.
- `openRuntimeEventStream` now supplies `loadOlder({ signal? })` and
  `hasOlder()`. It publishes the merged state before resolving the promise,
  leaves the live forward/ack cursor unchanged, merges concurrent live appends,
  coalesces repeated loads, checks exact duplicates/conflicts/continuity and
  fences cancellation, disposal and session-generation replacement. Accepted
  backfill enters the existing Chat model event projection. Client retention
  remains 1,000 events, with no secondary durable transcript.

## Exact #1385 integration handoff

The current main canvas uses ConversationSurface. #1385 replaces that with the
unreleased MessageScroller from UI #416; editing it here would overlap its owner.
The producer/client API can land independently. The canvas owner must:

1. In `chat-view.tsx`, retain the current `model.openTranscript()` handle and
   provide a callback which awaits `handle.loadOlder?.()` for that mounted
   session/generation. Use the same attachment epoch and detach/close lifetime
   already used for stream updates. Show a safe error/retry for a refusal;
   `resync_required` needs reattachment, not a successful empty insertion.
2. Forward `hasOlder`, `loadingOlder` and `onLoadOlder` through ChatTranscript
   to MessageScroller. Read `handle.hasOlder?.()` when the stream subscription
   publishes. Optional methods mean unavailable/demo providers must advertise no
   loader unless they supply one.
3. Keep `resetKey` as session + generation and keep stable Message `anchorId`s.
   MessageScroller captures the visible anchor before awaiting the loader and
   restores it during insertion/layout settlement. Its awaited callback must
   resolve only after accepted events are published (the new handle does this).
   Do not manually scroll or replace keyed message nodes in the host callback.
4. Replace the blanket checkpoint notice with the typed retained bounds,
   loading/retry state and permanent retention boundary. Preserve a boundary
   notice when the oldest retained sequence is greater than 1.
5. Run the real canvas browser test with multiple pages, a parked reader,
   concurrent append, retry, cancellation and A → B → A selection; verify the
   same visible anchor offset, no duplicate DOM rows and no stale insertion.

Unit tests prove canonical order, stable event identities and unchanged live
cursor across insertion, not rendered pixel geometry. The actual scroller
callback/DOM binding and browser scroll acceptance remain unverified until the
#1385 owner connects these APIs after the shared dependency is available.
No UI dependency release is authorized by this task.

The current production desktop Chat model is constructed without a `sendInput`
transport (`apps/web/src/lib/desktop-chat-host.ts`). This slice makes the actual
production launch prompt record displayable; it does not fabricate later user
messages or create a second input-authority path. Any future follow-up sender
must emit the same content projection only after its own authorized delivery.

## Validation ledger

Initial focused history tests failed because no history API existed. New focused
storage, gate, prompt and client-loader tests now pass. They cover foreign
account/workspace/node/session, stale generation, tampered/malformed/query-bound
cursors, restart/retry, exclusive page edges, byte/count bounds, concurrent
append, retention pruning/gaps, redaction and memory exclusion, repeated/cancelled
loads, late disposal and generation replacement. Exact final suite results are
recorded in the draft PR and updated below after the final validation run.

`bunx code-foundry doctor`: passed. `bun install --frozen-lockfile`: passed,
without dependency or lockfile changes. No delegates or development servers were
started; only bounded build/test/check commands are task-owned processes. The
isolated worktree/branch is intentionally retained for the draft PR and review.
