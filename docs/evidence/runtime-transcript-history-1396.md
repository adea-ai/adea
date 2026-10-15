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
   At the inspected #1385 head, `buildChatTurns` keys the leading partial turn
   as `lead`, and assistant messages use `${turn.id}:reply` as the anchor. Loading
   that turn's earlier prompt changes its key to the prompt event id; extending
   an assistant delta block backward can also change its first-event entry id.
   The owner must preserve a retained visible event's anchor through regrouping
   (or supply an explicit equivalent-anchor mapping to the scroller). A test
   containing only complete prompt turns will miss this case. Include a page
   boundary inside one assistant reply and another immediately before its prompt.
4. Replace the blanket checkpoint notice with the typed retained bounds,
   loading/retry state and permanent retention boundary. Preserve a boundary
   notice when the oldest retained sequence is greater than 1.
5. Run the real canvas browser test with multiple pages, a parked reader,
   concurrent append, retry, cancellation and A → B → A selection; verify the
   same visible anchor offset, no duplicate DOM rows and no stale insertion.
6. Read `turn.user_input.payload.textTruncated` when projecting the person's
   bubble and disclose a truncated prompt. Existing presentation code's own
   `bodyTruncated` only describes its display cut; it must also include the
   producer's explicit cut. Keep legacy/memory-only receipts textless.

Unit tests prove canonical order, stable event identities and unchanged live
cursor across insertion. The optional headless boundary qualification below
also proves pixel anchoring with real MessageScroller source and event-keyed
rows. Actual #1385 turn regrouping, callback/DOM binding and rendered canvas
acceptance remain unverified until its owner connects these APIs after the
shared dependency is available.
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
loads, late disposal and generation replacement. The resync regression also
proves that replaying already backfilled events advances the expected live
sequence without adding duplicate rows.

| Command                                                                                                                                                                          | Result                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `bun test apps/desktop/tests/dev-runtime-transcript-history.test.ts apps/desktop/tests/dev-runtime-harness-events.test.ts apps/desktop/tests/dev-runtime-harness-prompt.test.ts` | 32 pass, 191 assertions; real command-gate and sidecar/fake-PTY integration fixtures included                             |
| `bun test apps/desktop/tests`                                                                                                                                                    | 1,396 pass, 4 skip, 0 fail                                                                                                |
| `bun test --conditions=browser packages/dev-view/tests`                                                                                                                          | 896 pass, 3,293 assertions                                                                                                |
| `bun test packages/types/tests`                                                                                                                                                  | 238 pass, 2,502 assertions                                                                                                |
| `bun run test:security`                                                                                                                                                          | 31 pass, 206 assertions                                                                                                   |
| `bun run typecheck`                                                                                                                                                              | 31/31 tasks successful                                                                                                    |
| `bun run lint`                                                                                                                                                                   | 17/17 workspace tasks successful; root Oxlint clean                                                                       |
| `bun run build`                                                                                                                                                                  | 15/15 tasks successful                                                                                                    |
| `bun run format:check`                                                                                                                                                           | All 2,499 matched files formatted                                                                                         |
| `node scripts/generate-dev-runtime-contract.mjs --check`                                                                                                                         | Passed; generated registry/metadata current                                                                               |
| `bun test scripts/docs-boundary.test.ts`                                                                                                                                         | 4 pass, 15 assertions                                                                                                     |
| `bun run test:unit`                                                                                                                                                              | All 30 workspace tasks successful; subsequent root coverage lane fails the unchanged themes-pin guard: 1,162 pass, 1 fail |

The root failure is `scripts/themes-pin.test.ts:260`: its installed-copy scanner
uses `Dirent.isDirectory()` and misses Bun's symlinked
`node_modules/.bun/@adea-ai+themes@0.10.6` entry. The identical unchanged guard
also fails alone with 3 pass/1 fail. This is not a transcript failure and is not
waived, weakened or fixed in this scope. The first broad run also hit an
unchanged terminal transport timing assertion under concurrent build load;
its isolated rerun passed 27 tests, and both final Desktop and root workspace
runs passed it. Root `test:unit` is still a failing command overall.

The four Desktop skips are existing opt-in packaged terminal replay, worktree
containment, browser/devices and sidecar-flood lanes. No new packaged bundle,
real model/harness execution, remote production test or rendered #1385 canvas
acceptance was performed. The database-wide `test:integration` lane was not run:
no database/schema path changed; the relevant integration fixtures above exercise
the authenticated runtime gate and prompt delivery directly.

### Headless shared-scroller boundary qualification

`bun scripts/test-runtime-transcript-scroll.mjs --ui-source "$ADEA_UI_SOURCE"`
passed against the pinned UI #416 head above. The script reads MessageScroller
and its anchor helper with `git show`, adapts only import paths, and puts them
in a disposable Solid fixture. It uses the real event store and client history
loader, an isolated headless Chromium context, and an equal-height loader row
matching the published small-control layout contract. It changes no UI files,
dependency pins or installed package contents.

Two accepted backward pages preserve the original keyed DOM node at offset
`-46 px` before and after insertion (tolerance 1 px), including a concurrent
live append. The fixture ends with 41 unique rows and zero duplicates. Four
requests cover an initial coalesced double-click, an HTTP 503 refusal, a retry,
and a late response fenced by disposal. The failed and cancelled loads leave
both the visible rows and anchor offset unchanged. The script closes its
browser/server and deletes the fixture in `finally`. This is a boundary proof,
not the actual grouped canvas or native packaged acceptance.

`bunx code-foundry doctor`: passed. `bun install --frozen-lockfile`: passed,
without dependency or lockfile changes. No delegates were started. The bounded
scroll qualification's temporary server and browser were closed. The
isolated worktree/branch is intentionally retained for the draft PR and review.
