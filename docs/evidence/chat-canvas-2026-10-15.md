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
| Activity     | Chain of Thought | Live            | `turn.method_step_summary` (#1388): keyed steps, source-reported title, text, status and duration              |
| Activity     | Reasoning        | Live            | `turn.reasoning_summary` (#1388): one node per summary id, replaced by a higher revision; never inferred       |
| Activity     | Tool             | Partly live     | tool events render as Trace lines; no call identity to pair started with completed, so no inputs/outputs panel |
| Activity     | Subagent         | Partly live     | `subagent.*` events render as lines; no nesting contract                                                       |
| Activity     | Task             | Available       | no task-list event                                                                                             |
| Activity     | Plan             | Available       | no plan event                                                                                                  |
| Activity     | Queue            | Available       | the host has no queue operation (`dev-runtime.md`)                                                             |
| Results      | Terminal         | Available       | no structured command-output event                                                                             |
| Results      | Stack Trace      | Available       | no failure payload schema                                                                                      |
| Results      | Test Results     | Available       | no structured test-run payload                                                                                 |
| Results      | File Tree        | Available       | no changed-files event                                                                                         |
| Grounding    | Sources          | Live            | `turn.assistant_message` `references.sources` (#1389), shown with the answer they belong to                    |
| Grounding    | Inline Citation  | Live            | `references.citations` offsets, placed by `placeCitationMarkers` only where the text still is the payload text |
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
| User-visible reasoning summaries (contract merged on main; drawn)                                                                            | [#1388](https://github.com/adea-ai/adea/issues/1388) | drawn only from a validated, source-reported summary                                                                                                                                            |
| Sources and citations (contract merged on main; drawn)                                                                                       | [#1389](https://github.com/adea-ai/adea/issues/1389) | drawn only from producer references; text never creates a citation                                                                                                                              |
| Restorable checkpoints                                                                                                                       | [#1390](https://github.com/adea-ai/adea/issues/1390) | none shown                                                                                                                                                                                      |
| Token and context usage with a documented payload                                                                                            | [#1391](https://github.com/adea-ai/adea/issues/1391) | none shown                                                                                                                                                                                      |
| Attachments with a working upload/open path                                                                                                  | [#1392](https://github.com/adea-ai/adea/issues/1392) | none                                                                                                                                                                                            |
| Queued follow-ups (a queue operation)                                                                                                        | [#1393](https://github.com/adea-ai/adea/issues/1393) | none; Steer and Stop only where authorized                                                                                                                                                      |
| Test-run, terminal, stack-trace, changed-file, plan and task payload schemas                                                                 | [#1394](https://github.com/adea-ai/adea/issues/1394) | lines only                                                                                                                                                                                      |
| Question schema (options, multi-question) and approval outcome/request correlation (`approval.resolved` naming the request and the decision) | [#1395](https://github.com/adea-ai/adea/issues/1395) | free-text questions; a quiet line for later approval events, no approved/denied claim                                                                                                           |
| Older-history loading (a checkpoint that returns earlier events) and production `turn.user_input` text                                       | [#1396](https://github.com/adea-ai/adea/issues/1396) | `onLoadOlder` is wired in the shared scroller only, the host shows the bounded-history notice; the register records a delivery receipt without text, so the canvas draws what the event carries |

### Summaries and cited answers

- **Gate.** Every summary and cited answer passes `decodeRuntimeEvent` from
  `@adea-ai/types/dev-runtime-wire` before it is drawn. Anything that fails stays an
  "other" row labelled by its wire kind, with no content.
- **Summaries.** One node per summary id (reasoning) or method id and step id
  (method), keyed by the first event's id. A snapshot replaces its node only with a
  higher revision and never after a terminal status; a step keeps its position.
  A last word of `streaming` or `running` animates only while the session is live;
  after that it reads "not finished". Text is redacted and bounded for display.
- **Citations.** Sources are listed whenever the producer supplied them. A marker
  `[^n]` is placed only at a producer span end, only when the displayed body is a
  verbatim slice of `payload.text`, and only where the shared parser agrees it is
  prose (not code, a link label, or split emphasis). Otherwise the sources remain
  and the row says "n citation(s) is/are not marked in the text".
- **Source text is untrusted.** Source titles and snippets pass the same display
  redaction as message text (secrets, bearer tokens, private paths, control
  characters, bounded length). A link the redaction would change is dropped: the
  source is listed by title without a link, never linked to a rewritten or
  secret-bearing address. A path such as `/home/...` in a URL is treated as private
  and also drops the link (it fails closed).
- **The unmarked count is per span.** Spans that end together share one marker; the
  note counts producer spans whose end received a marker (`placeCitationMarkers`
  returns `ends`), not marker positions.
- **Still absent on purpose.** Usage, checkpoints, queue, attachments, and the
  streaming-to-final supersession, tool/subagent nesting and approval outcomes (see
  the dependency matrix). #1417 is draft and unverified, so nothing from it is consumed.

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

## Dependency matrix (2026-10-16)

| Dependency                        | Exact head                                                                | State                                                                                                                  | How this canvas treats it                                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adea `main`                       | `959da6d7b577e3c3d298ac407e7499f600946fe5`                                | branch merged `632776c7` (`0c828d14`); main has since moved, and a dry-run merge (2026-10-17) has no textual conflicts | visible-summary (#1388) and cited-response (#1389) contracts consumed through `decodeRuntimeEvent`                                                                                                                           |
| `adea-ai/ui` #416 (AI Elements)   | `a26b693560bae32889ecbc7165a649f6ab239709`                                | open, draft                                                                                                            | adds `placeCitationMarkers` and the preserved repair patch (sha256 `b9c1c3beb1c6f7478050aaacc403178ec2d27228998bacef2dd1f07aadd436b2`, base `50562af`, applied unchanged apart from a type cast in its confirmation fixture) |
| Published `@adea-ai/ui`           | 0.134.0 pinned on this branch; 0.137.0 pinned on main; 0.141.0 is ui main | none has the AI Elements exports (#416 is unreleased)                                                                  | Adea typecheck, build and CI cannot pass until a release containing #416 is published and pinned; local checks here use a build mirror that is never committed                                                               |
| #1417 runtime contracts and queue | `60c0f597d0fdfbeef34f22d34155b9878af308ea`                                | draft, blocked on review and validation                                                                                | not consumed: no supersession, tool or subagent identity, approval outcome, usage or queue adapter yet                                                                                                                       |
| #1414 native session inventory    | `cdf186402e017548ee5793c25bab73430b98ef72`                                | draft, Workspace Details; not this canvas                                                                              | no overlap with `packages/dev-view/src/chat/`                                                                                                                                                                                |
| #1412 connection read models      | `27a28322ff133cc819d4169d91d828e2d264ef78`                                | open; unknown upstream fields stay unknown                                                                             | not a chat input                                                                                                                                                                                                             |
| #1402 history, #1407 attachments  | draft                                                                     | not drawn as working capabilities                                                                                      | attachments and older-history loading stay absent or explicitly unavailable                                                                                                                                                  |

This PR stays draft until a ui release is published and pinned (the version bump
goes through the coordinator).
