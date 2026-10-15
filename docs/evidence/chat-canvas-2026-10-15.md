# Chat canvas on the shared AI Elements foundation (#1383)

Tracks [#1383](https://github.com/adea-ai/adea/issues/1383). It accompanies
`docs/evidence/donor-ui-runtime-event-boundary.md`, whose rules it keeps: a
status, a call identity, an approval outcome or a final answer is drawn only
when a validated host fact says it. Nothing here is evidence of a working
production ACP stream; the fixtures prove the canvas, not the producers.

The shared components live in `adea-ai/ui` (coverage matrix:
`docs/ai-elements-coverage.md` there). This repository holds the thin adapters:
`packages/dev-view/src/chat/` (`model/turns.ts`, `chat-transcript.tsx`,
`chat-approval.tsx`, `chat-view.tsx`).

## What the canvas does

- **Turns.** A `turn.user_input` event opens a turn; everything after it nests
  under one assistant response until the next prompt. Events before the first
  prompt form a lead turn. Consecutive `turn.assistant_delta` events from one
  harness run and generation are one prose block (id = the first delta's id).
- **One quiet column.** Tool, file, subagent, usage and unknown events are Trace
  lines in one column under the response. Only the two things the person must act
  on (a `requested` approval, a `question.requested`) draw a card.
- **Honest status.** A line carries a status only from its own event kind
  (`*.completed` success, `*.failed` error). `started`, `requested` and
  `progress` show as words with a neutral mark. A spinner and "Working" come only
  from the host's session lifecycle (`active`); while an approval is pending the
  line reads "Waiting for a response from you".
- **Authority is unchanged.** Approve, Deny and Submit answer go through the same
  `onResolveApproval`/`onResolveQuestion` callbacks; with none supplied the controls
  stay visible and disabled with the reason in words. Answering is a round trip;
  the form reopens after submit, because only a `question.resolved` event proves
  the runtime accepted the answer; the client never marks it accepted.
- **Unknown events stay visible.** An unrecognised kind is a line labelled by its
  wire kind, in position, without payload content. Only `credential`-classified
  events are not drawn.
- **Stable DOM while streaming.** Turns, activity columns, lines and prose blocks
  are keyed by id, so a growing reply keeps its node, selection, focus and
  question draft (a draft-loss bug in the first version of this canvas was found
  by `chat-transcript-composition.spec.ts` and fixed).
- **Reader intent.** The shared `MessageScroller` follows only while the reader is
  at the bottom, parks otherwise, offers "Jump to latest", restores the reading
  position per session and generation, and announces "Assistant is responding" /
  "Response finished" from lifecycle changes.
- **Code and output.** Fences render through the shared `CodeBlock`: streaming-safe
  (a partial fence is a block that says "Generating…"), exact copy of the source,
  wrapping, a 24rem bounded height, and no highlighter. Plain output loads no
  grammar or highlighter payload.

## Coverage of the 21 patterns

"Live" means the canvas binds it to real runtime data today. "Available" means the
shared component exists and is demonstrated in `adea-ai/ui` stories, but the
Adea chat does not draw it because no producer supplies its data.

| Group        | Pattern          | Adea chat       | Binding or the missing contract                                                                                |
| ------------ | ---------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| Conversation | Chat             | Live            | `ChatView` frame: header, notices, thread, composer                                                            |
| Conversation | Message          | Live            | user and assistant turns from `buildChatTurns`                                                                 |
| Conversation | Prompt Input     | Live (existing) | `AtomicChatComposer`, unchanged: draft, send, Stop/Steer where authorized                                      |
| Conversation | Suggestion       | Available       | no prompt-suggestion producer                                                                                  |
| Activity     | Chain of Thought | Available       | no step-level method summary event                                                                             |
| Activity     | Reasoning        | Available       | no user-visible reasoning summary event; none is invented                                                      |
| Activity     | Tool             | Partly live     | tool events render as Trace lines; no call identity to pair started with completed, so no inputs/outputs panel |
| Activity     | Subagent         | Partly live     | `subagent.*` events render as lines; no nesting contract                                                       |
| Activity     | Task             | Available       | no task-list event                                                                                             |
| Activity     | Plan             | Available       | no plan event                                                                                                  |
| Activity     | Queue            | Available       | the host has no queue operation (`dev-runtime.md`)                                                             |
| Results      | Terminal         | Available       | no structured command-output event                                                                             |
| Results      | Stack Trace      | Available       | no failure payload schema                                                                                      |
| Results      | Test Results     | Available       | no structured test-run payload                                                                                 |
| Results      | File Tree        | Available       | no changed-files event                                                                                         |
| Grounding    | Sources          | Available       | no citation or source event                                                                                    |
| Grounding    | Inline Citation  | Available       | same                                                                                                           |
| Controls     | Confirmation     | Live            | `approval.requested` (requested state only)                                                                    |
| Controls     | Checkpoint       | Available       | no restorable-checkpoint contract                                                                              |
| Controls     | Context          | Available       | `usage.observed` payload is opaque                                                                             |
| Controls     | Model Selector   | Live (existing) | the composer's harness/model pins                                                                              |

Questionnaire is live for `question.requested` (free text only). Attachment is not
drawn because no attachment action works end to end.

## Backend and contract dependencies

Each of these is a separate, tracked follow-up; none is claimed complete by this
work. Until it exists the canvas shows the honest fallback in the right-hand column.

| Missing contract                                                                                                                             | Issue                                                | Today's behaviour                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delta to message supersession (a stable message identity so a streamed message and its final `turn.assistant_message` are one)               | [#1386](https://github.com/adea-ai/adea/issues/1386) | both render                                                                                                                                                                                     |
| Call identity and phase for `tool.*` and `subagent.*` events                                                                                 | [#1387](https://github.com/adea-ai/adea/issues/1387) | separate lines; no spinner pairing, no inputs/outputs                                                                                                                                           |
| User-visible reasoning summaries                                                                                                             | [#1388](https://github.com/adea-ai/adea/issues/1388) | none shown                                                                                                                                                                                      |
| Sources and citations                                                                                                                        | [#1389](https://github.com/adea-ai/adea/issues/1389) | none shown                                                                                                                                                                                      |
| Restorable checkpoints                                                                                                                       | [#1390](https://github.com/adea-ai/adea/issues/1390) | none shown                                                                                                                                                                                      |
| Token and context usage with a documented payload                                                                                            | [#1391](https://github.com/adea-ai/adea/issues/1391) | none shown                                                                                                                                                                                      |
| Attachments with a working upload/open path                                                                                                  | [#1392](https://github.com/adea-ai/adea/issues/1392) | none                                                                                                                                                                                            |
| Queued follow-ups (a queue operation)                                                                                                        | [#1393](https://github.com/adea-ai/adea/issues/1393) | none; Steer and Stop only where authorized                                                                                                                                                      |
| Test-run, terminal, stack-trace, changed-file, plan and task payload schemas                                                                 | [#1394](https://github.com/adea-ai/adea/issues/1394) | lines only                                                                                                                                                                                      |
| Question schema (options, multi-question) and approval outcome/request correlation (`approval.resolved` naming the request and the decision) | [#1395](https://github.com/adea-ai/adea/issues/1395) | free-text questions; a quiet line for later approval events, no approved/denied claim                                                                                                           |
| Older-history loading (a checkpoint that returns earlier events) and production `turn.user_input` text                                       | [#1396](https://github.com/adea-ai/adea/issues/1396) | `onLoadOlder` is wired in the shared scroller only, the host shows the bounded-history notice; the register records a delivery receipt without text, so the canvas draws what the event carries |

## Qualification evidence

Browser specs, all against the development fixture (`/?view=chat&chatE2e=visual`):

- `apps/web/e2e/chat-canvas.spec.ts` (29 checks): streaming into a stable node with
  a busy marker and a partial fence; follow at the bottom, parked when reading up,
  Jump to latest; Stop once; cancelled and failed states; the empty state;
  approvals and questions by mouse and keyboard with the exact event recorded;
  source-exact copy; hostile text (no elements, no script, no `javascript:` link,
  redaction, unknown language, unknown event, long token); a 2,500-line block and
  over-limit prose; log/status roles, articles, spoken statuses, `aria-expanded`;
  axe in light and dark; touch target; reduced motion; 320px; light/dark.
- Existing suites updated for the new markup and still passing: `chat-view`,
  `chat-view-visual` (linux baselines are refreshed by the visual-lane dispatch,
  not committed from a laptop), `desktop-runtime-chat`, `chat-transcript-composition`,
  `history-pane`.
- Two failures also occur on `main` in this environment and are unrelated:
  `direct-session-handoff` (404 console error) and the Dev to Chat switch test (401).
- Unit: `chat-turns.test.ts` (including whitespace-only streamed fragments, spaces, newlines, tabs and fence fragments projected through to the turn, with redaction and bounds) and `chat-surface.test.ts`.

Shared-UI qualification (focused Playwright specs for trace, code block, message
text, message scroller and questionnaire; unit tests for the parser and every
pattern's model; Storybook scenarios) is listed in the `adea-ai/ui` PR.

## Bundle

Plain `vite build` in `apps/web`, then `node start/check-client.mjs`, compared with
`main` at fddfdaf: client JS files 166 and 166 (cap 167); chat route 187,166 to
189,782 raw and 61,808 to 62,646 gzip (caps 303 KiB, 102 KiB); dev utility panes
185,325 and 185,325; start-up 683,758 to 683,873 raw. No cap changed and no gate
was weakened. The development fixtures are `import.meta.env.DEV` only and cost
nothing in production.

## Screenshots

`/mnt/project-files/adea/chat-canvas/before/` (main) and `after/` (this branch):
empty, rich, attention, conversation, streaming, reconnect, cancelled, failed,
hostile, large and a partial code stream, light and dark, desktop and mobile.

## Dependency note

This branch needs the unreleased `@adea-ai/ui` from `adea-ai/ui` (the AI Elements
pull request). Adea still pins 0.131.0; the version bump and lockfile change go
through the coordinator after the ui release, so this PR stays draft until then.
