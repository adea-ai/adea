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
- **One quiet column.** File and unknown events are Trace lines in one column
  under the response. Tool and subagent events that carry a validated call identity
  are nested call trees (`Tool`, `Subagent`); structured results are drawn by the
  shared Terminal, Test Results, Stack Trace, File Tree, Plan and Task components.
  Only the two things the person must act on (a `requested` approval, a
  `question.requested`) draw a card.
- **Honest status.** A line carries a status only from what its producer sent
  (`completed` success, `failed` error). `started`, `requested` and `progress`
  show as words, and a call is drawn as running only while the session is live;
  afterwards it reads "not finished". A spinner and "Working" come only from the
  host's session lifecycle (`active`); while an approval is pending the line
  reads "Waiting for a response from you".
- **Calls and results.** Calls fold by `callId` (phase only moves forward, a
  terminal phase is final; an output, duration, name, input or parent observed after
  the end still fills what was never observed and never rewrites what was) and nest under a `parentCallId` within the same turn
  and scope; an ambiguous, conflicting or cyclic parent leaves the call at the top
  level, depth is capped at 6, and an input or output that is a reference or
  shortened says so, on a tool and on a subagent alike. Inline call data is
  redacted leaf by leaf before it is written as JSON (JSON escaping would otherwise
  hide a Windows path or a token with a control character from the patterns), a
  credential-named key withholds its value, and a secret that only forms across
  fields withholds the whole value; numbers and booleans count as fragments, and a
  fragment in a key or between keys is joined too: every key and value is a candidate
  start, read with whitespace collapsed and empty fragments free, so padding cannot use
  up the budget. A withheld credential value is a barrier no reading crosses. Terminal chunks are ordered by
  sequence within their own stream (`stdout`, `stderr`, `combined`), joined, stripped of
  control sequences and redacted once, so a secret split across chunks or hidden in
  an escape sequence is still redacted; output after the finish still extends the
  text and never changes the outcome. A snapshot is replaced by a later one until the
  producer gives a terminal status; `complete: true` only says a list is whole. Permission eligibility is never read as
  authorization.
- **Reported figures.** A `usage.observed` snapshot belongs to one provider and
  model. The newest accepted snapshot of the model the host names (`usageModel`)
  feeds the shared Context trigger beside the composer; a model id without a provider is
  used only when one provider reported it, and two providers sharing the id draw nothing;
  with no model named, the
  figures are drawn only if the generation reported a single model, so another
  model's occupancy is never shown as this conversation's. A figure the producer
  did not send is omitted, never zero. The reported cost stays the producer's exact
  decimal text and is shown beside the trigger as text; the shared Context takes
  only a number, so it is not passed there. A `checkpoint.observed` is a
  marker in the column with no restore action, because no host operation reaches
  the canvas.
- **Older messages.** A bounded history control loads earlier events through the
  existing `MessageScroller`; one request at a time per epoch, a failure keeps the
  position and offers a retry. `MessageScroller` keeps the reader's place by turn, so
  a reply split across history pages (one turn whose withheld placeholder becomes the
  restored reply) would move the view; the transcript pins the first visible entry by
  node across each load and puts back whatever it still drifted unless the reader
  scrolled meanwhile. A mounted regression reads the middle of a long reply, loads
  both earlier pages with the real control and holds the offset within 2px, focus kept.
- **A stream that ends is not live.** Every `close` frame and every `error` frame is
  recorded, and so is a transport close. The chat leaves "Live", says Disconnected
  (with the host's reason for anything but a stale generation) and reconnects; when
  the cursor was refused (an `incompatible` close, or a close after a `sequence_gap` or
  `resync_required` error) it reconnects without the rejected `newestSequence`. The state
  a handle opens with is judged by the same logic as every later one, so a handle that
  ended before anyone subscribed is never shown as live, and the refusal is spent only by
  an attachment that gets going: a recovery that fails to open, or opens already ended,
  asks from the beginning again.
- **Interactions are checked as events.** An approval or question is drawn only after
  `decodeRuntimeEvent` accepts the whole event (authoritative provenance, private
  classification, a harness run), not just its payload; an assistant message is keyed
  the same way. An outcome settles a request only in the same binding, adapter
  source and harness run, and a question outcome only when its answers satisfy the
  retained request (a required question never settles with no answer).
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

| Group        | Pattern          | Adea chat        | Binding or the missing contract                                                                                                        |
| ------------ | ---------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation | Chat             | Live             | `ChatView` frame: header, notices, thread, composer                                                                                    |
| Conversation | Message          | Live             | `buildChatTurns`; a streamed message and its final `turn.assistant_message` are one turn by `messageId`/`supersedes`                   |
| Conversation | Prompt Input     | Live (existing)  | `AtomicChatComposer`, unchanged: draft, send, Stop/Steer where authorized                                                              |
| Conversation | Suggestion       | Available        | no prompt-suggestion producer                                                                                                          |
| Activity     | Chain of Thought | Live             | `turn.method_step_summary` (#1388): keyed steps, source-reported title, text, status and duration                                      |
| Activity     | Reasoning        | Live             | `turn.reasoning_summary` (#1388): one node per summary id, replaced by a higher revision; never inferred                               |
| Activity     | Tool             | Live             | `tool.*` with a validated versioned call (#1387): one node per `callId`, nested, redacted bounded input/output                         |
| Activity     | Subagent         | Live             | `subagent.observed` calls nest children by `parentCallId`; legacy events stay lines                                                    |
| Activity     | Task             | Live             | `task.observed` (#1394)                                                                                                                |
| Activity     | Plan             | Live             | `plan.observed` (#1394); progress is computed only when the producer marks the list complete                                           |
| Activity     | Queue            | Live             | `dev.session.followUps` (#1393): Queue control and list only after a successful read; explicit one-at-a-time delivery, never automatic |
| Results      | Terminal         | Live             | `terminal.output` chunks, ordered, joined, control-stripped, redacted once                                                             |
| Results      | Stack Trace      | Live             | `failure.observed`                                                                                                                     |
| Results      | Test Results     | Live             | `test_run.observed`; counts as sent, each suite's reported status listed apart from the tests it holds, running states only while live |
| Results      | File Tree        | Live             | `files.changed`; copied or untracked changes carry no mark the producer did not send                                                   |
| Grounding    | Sources          | Live             | `turn.assistant_message` `references.sources` (#1389), shown with the answer they belong to                                            |
| Grounding    | Inline Citation  | Live             | `references.citations` offsets, placed by `placeCitationMarkers` only where the text still is the payload text                         |
| Controls     | Confirmation     | Live             | requested, approved, denied, expired or unavailable, paired by the correlated outcome (#1395)                                          |
| Controls     | Checkpoint       | Live (marker)    | `checkpoint.observed` through `decodeConversationCheckpoint`; no restore control, the host op is not reachable                         |
| Controls     | Context          | Live (read-only) | newest `usage.observed` of the named model in the generation; cost kept as the producer's decimal text, beside it                      |
| Controls     | Model Selector   | Live (existing)  | the composer's harness/model pins                                                                                                      |

Questionnaire is live for `question.requested` (free text only). Attachment is not
drawn: `dev.session.attachment*` exists host-side but no dev-view model or platform
action reaches the canvas, so no attach control is shown. The same holds for
checkpoint restore. Suggestion has no producer.

## Backend and contract dependencies

Each of these is a separate, tracked follow-up; none is claimed complete by this
work. Until it exists the canvas shows the honest fallback in the right-hand column.

| Missing contract                                                                                                                             | Issue                                                | Today's behaviour                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Delta to message supersession (a stable message identity so a streamed message and its final `turn.assistant_message` are one)               | [#1386](https://github.com/adea-ai/adea/issues/1386) | consumed: one turn by message identity (`a71fae68`)                                                                                         |
| Call identity and phase for `tool.*` and `subagent.*` events                                                                                 | [#1387](https://github.com/adea-ai/adea/issues/1387) | consumed: nested call tree, redacted bounded input/output                                                                                   |
| User-visible reasoning summaries (contract merged on main; drawn)                                                                            | [#1388](https://github.com/adea-ai/adea/issues/1388) | drawn only from a validated, source-reported summary                                                                                        |
| Sources and citations (contract merged on main; drawn)                                                                                       | [#1389](https://github.com/adea-ai/adea/issues/1389) | drawn only from producer references; text never creates a citation                                                                          |
| Restorable checkpoints                                                                                                                       | [#1390](https://github.com/adea-ai/adea/issues/1390) | consumed as a marker only; restore is not offered                                                                                           |
| Token and context usage with a documented payload                                                                                            | [#1391](https://github.com/adea-ai/adea/issues/1391) | consumed: Context trigger from the newest accepted `usage.observed`                                                                         |
| Attachments with a working upload/open path                                                                                                  | [#1392](https://github.com/adea-ai/adea/issues/1392) | none                                                                                                                                        |
| Queued follow-ups (a queue operation)                                                                                                        | [#1393](https://github.com/adea-ai/adea/issues/1393) | consumed: Queue control and list after a successful host read; Send next is explicit and one at a time                                      |
| Test-run, terminal, stack-trace, changed-file, plan and task payload schemas                                                                 | [#1394](https://github.com/adea-ai/adea/issues/1394) | consumed: Terminal, Test Results, Stack Trace, File Tree, Plan, Task                                                                        |
| Question schema (options, multi-question) and approval outcome/request correlation (`approval.resolved` naming the request and the decision) | [#1395](https://github.com/adea-ai/adea/issues/1395) | consumed: free-text questions and paired approval outcomes; an unpaired outcome stays a quiet line                                          |
| Older-history loading (a checkpoint that returns earlier events) and production `turn.user_input` text                                       | [#1396](https://github.com/adea-ai/adea/issues/1396) | consumed: history control loads earlier events through the scroller; production `turn.user_input` text is still only what the event carries |

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
- **Still absent on purpose.** Attachments, checkpoint restore and prompt
  suggestions (#1392 is not wired: no operation reaches the canvas, and
  no producer exists for suggestions). Queued follow-ups (#1393) are wired: the
  host's snapshot is the only source, `accepted` is never worded as read, an
  ambiguous delivery is never retried. Nothing here claims a producer streams these
  events in production.

## Status band, evidence strip and child delegations (#1173/#1177)

The handoff section above the thread now draws what its model already derived:

- **Band.** Mode, generation, who holds the session (the workspace lead, you, or
  no one) and, after a return, why the turn ended.
- **Evidence strip.** Last retained event, approval, file, subagent and capability
  event counts. They are raw events from the retained window, labelled as such; an
  incomplete window says its counts are lower bounds and a terminal-fallback
  projection says it reports no structured events. The strip reads the window the thread
  displays, so streamed events and loaded history update it.
- **Child delegations.** The control-plane children read is display-only. A missing
  read reads "not connected", never "no children"; an unavailable read names its
  code and shows no count or list; a partial page, or a final cursor page that is complete but holds fewer
  children than the total, says how many it did not show and never reads as
  "all children"; a stop request is shown as "stop requested, not confirmed". Observed jobs
  keep their own reasons.
- **Controls.** Lead stop, session stop, handoff, job cancel and descendant cancel
  remain separate rows with separate handlers. Job and descendant cancel stay
  disabled: no cancel handler exists and CP #935/#937 are not delivered. The
  children read cannot enable them, because it carries no runtime-authenticated
  generation.

The production supplier does not read the children endpoint yet; the mounted proof
uses fakes (`?children=complete|partial|none|unavailable` in the handoff harness).

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

Consumption slice for #1383 (this branch, 2026-10-18):

- Unit (`packages/dev-view`, `bun run test`): 1121 pass, 0 fail before the
  checkpoint/Context slice, with `chat-history-control` (8), `chat-turns-calls`
  (15), `chat-turns-results` and `chat-usage` (7) covering epoch fencing, call
  folding and nesting, cycles, depth, terminal ordering, split-secret and ANSI
  redaction, checkpoint settlement and usage figures.
- Browser (`chat-canvas.spec.ts`): groups for tool and subagent calls, structured
  results (including the checkpoint marker and Context trigger, which opens its
  figures and returns focus on Escape), outcome cards, adapters that keep what the
  producer said (a subagent's input and references, a failed suite beside a passing
  test, a failed incomplete plan, files with no totals, a named model's context and
  exact cost text), and earlier messages (load once above the turn on screen; a
  failed load says so, keeps the control and does not retry in a loop); 65 passed
  with `chat-transcript-composition`.
- Lint, format and typecheck of the touched packages are clean.
- 22 browser-lane failures (12 visual-snapshot variants, nine in `chat-view.spec.ts`,
  one in `chat-continuity.spec.ts`) reproduce identically on `main`'s
  `packages/dev-view`; they are pre-existing and not caused by this branch.
- Hosted CI has not run: the pull request is a draft.

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

For the consumption slice: `check-client.mjs` and `scripts/check-dev-view-bundle.mjs`
both pass (chat route 191,955 raw / 62,706 gzip; dev shell 161,032 / 55,587), but the
production client does not include the dev-view chat transcript, so those gates do
not measure this work. The shared composites add about 5 KB gzip to the library
dist. No cap was raised.

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

### Post-redaction clipping follow-up

Personal review found a short-input expansion boundary:400 short Bearer tokens
plus a decisive instruction fit the raw input limit, but redaction replacements
pushed the instruction past the safe display bound. The sanitizer now returns
explicit clipping provenance after replacements as well as at its input window.
Both approval and question guards consume that provenance. Four new regressions
fail at c9e1a1d and pass after the repair, including exact sanitized boundaries,
removed control characters and one additional visible code point. Existing input,
output and privacy bounds remain unchanged. Earlier validation counts above are
the c9e1a1d checkpoint; the final follow-up receipt records updated check results.

### CI bundle and visual qualification follow-up

Host verify at ef9d397f exceeded the unchanged 185,344-byte Dev utility budget:
CI 185,579; local reproduction 185,636. Separate shared-model and shared-primitive
chunk groups reduce local raw bytes to 185,165, gzip 61,478 to 60,847 and files 16 to 12.
Pane components remain lazy; dependency recursion stays disabled. Startup raw
bytes change 687,502 to 687,489; Chat 193,365 to 193,606, with gzip 63,917 to 63,827 and
one fewer chunk. All route budgets pass; none was raised. Complete unchanged
`start:verify` passes, including 25 host tests, build, Bun checking and client guard.
Focused bundle suites pass 24 tests/74 assertions; Dev View 1,036/3,812 pass.

CI visual run 39074736114 at ef9d397f passed 80 workspace tests; its 12 ChatView
baselines still showed the former per-event cards. All 12 actual/expected/diff
triplets were inspected across conversation/attention/reconnect, light/dark and
desktop/mobile. Actuals show the approved shared bubbles, Trace, Confirmation,
Questionnaire and reconnect notices. Each CI expected matches its checked-in
baseline byte-for-byte, and each actual matches its retry byte-for-byte. Those
reviewed actuals replace only the 12 Linux ChatView baselines; screenshot tolerances
and test assertions are unchanged. Original CI artifact 12117030974 and hash
receipts remain available for the coordinator's visual review.

The corresponding 12 native Darwin triplets were also inspected before promotion;
all 13 unchanged native visual tests then passed in 44.0 seconds. The linked
[complete CI repair receipt](chat-canvas-ci-repair-2026-10-17.json) records both
platforms' original/actual hashes and all measured route closures. Linux uses the
existing CI image's actuals; a new-head hosted visual rerun remains pending.
