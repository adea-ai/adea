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

## Dependency matrix (verified 2026-10-17)

| Dependency             | Exact head or package                            | Verified state                                                           | Current qualification                                                                                                            |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Reconciled Adea main   | `65a30256d922a904e777abb5ca99b284283214ec`       | merged into this repair without conflicts                                | Includes #1398; host/types interaction implementation is unchanged by this consumer repair.                                      |
| UI #416, AI Elements   | merge `678192bd8d13b88328dde5665b1d56d3dac2250a` | merged 2026-10-17T17:54:52Z; included in the published foundation        | Actual registry exports are consumed by passing type checks/builds and the integrated browser suite below.                       |
| UI #462, parser safety | merge `ee309c8b1779a45e015bd7353913ae14a73d7f6f` | merged; included in release0.142.3                                       | No UI/theme PR remains open at admission; the prior shared-release hold is satisfied.                                            |
| Published UI           | `@adea-ai/ui@0.142.3`                            | GitHub release published21:27:40UTC; actual npm archive verified21:39UTC | Exact pin in all seven root/workspace manifests; frozen Bun install and integrated qualification below use the registry archive. |
| Published themes       | `@adea-ai/themes@0.10.10`                        | actual npm package verified; satisfies UI's `^0.10.10` range             | Bun lock contains one resolved catalogue version; direct and symlink-store audit passes.                                         |

Earlier fixture receipts above used local UI mirrors and earlier source pins.
Those historical results do not qualify the current release. The runtime producer
milestone #1383 remains open; existing host callbacks retain response authority.

## Current repair qualification (2026-10-17)

The existing Sol owner resumed under the explicit transfer, preserving the six-path
retention patch (SHA-256
`2be9ce478527f71f7ed95fec8ac7a5968c1888be3a31072b716d9f502256e49e`).
Current main `65a30256d922a904e777abb5ca99b284283214ec`, including #1398's
immutable interaction snapshots, reconciles without conflicts. Its types and
host implementation remain unchanged by this consumer repair.

The retention fix carries one bounded provenance boolean and withholds the
leading incomplete assistant streak after eviction/replay; it never retains
secret prefixes. Approval/question inspection now uses a dedicated redacted
request context within the existing 4,096-character limit. Missing or clipped
context disables approval/answer submission, including callback guards. Question
wording outranks incidental text; incomplete details are labeled as previews.
Tool output uses separate safe LF/tab-preserving text for copy, normalizing CRLF
to LF. Credentials/private paths remain redacted; other unsafe controls remain
removed. Citation fixtures include the current required message identity fields;
no decoder or size limit was weakened.

UI #416 and #462 have merged; UI v0.142.3's GitHub release exists and themes
0.10.10 is available in the registry. The actual UI0.142.3 registry archive became
available at21:39UTC, with integrity
`sha512-h8kxErZ+NmX+yZUjuWpeHfWzPgfxNJ5gyHGntIky2uvgHxGo480GMUy98nGxNBjAhPr8e6VDdl6Dxyntihd8Ng==`.
All seven root/workspace manifests pin that release exactly and the Bun lock records its archive
and themes0.10.10 dependency. Validation below uses that released package. Historical local
UI mirrors and earlier browser results above are not current release evidence.
The PR remains draft with auto-merge off; the coordinator owns exact-head review.

Qualification also covers Bun's symlinked global store: the theme boundary follows
matching installed store links and still rejects an incompatible catalogue. A
new symlinked-store regression proves that fail-closed behavior. The dev icon shim
uses the installed Lucide canonical ShieldQuestion module. A clean frozen install
removed unused local store links; all 18 theme/icon/release boundary tests pass.
Linux workflow fixture tests use the existing Homebrew GNU tools on this Mac.

Current local validation uses Bun1.4.3 and Node24.21.0:

- Dev View:1,032 tests/3,786 assertions, zero failures.
- Workspace unit task graph:32/32 tasks successful. The separate coverage lane
  passes1,295 tests/14,080 assertions in isolation, zero failures.
- The complete chat-canvas browser suite passes47/47 against the actual registry
  UI package and an isolated loopback server/database, including retention DOM
  identity, safe truncation, citations, keyboard/touch behavior and accessibility.
- Full formatting, lint, Bun type checking, required declaration/library emit and
  production build pass. The unchanged normal commit hook gates publication.

Retained diagnostic evidence: the first browser run hit the default4GB Node heap
limit and exposed stale citation fixture identity fields; a corrected rerun
passed46/47 and exposed withheld-fragment grouping, now repaired and pinned by a
failing-before/passing-after1,000-row regression. The complete final browser run
passes with an8GB local heap. Initial coverage also exposed the Bun-store/icon
boundaries above and GNU-stat fixture requirements. A concurrent coverage run
had one100ms child-startup fixture failure; its unchanged isolated rerun passes
all1,295 tests. No assertion, deadline, privacy rule or bound was relaxed.
Historical UI mirrors, screenshots and other browser-lane results above remain
historical; packaged, full-app integration and visual-baseline lanes are not
claimed by these focused repair receipts.
