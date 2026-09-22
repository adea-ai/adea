# M13 chat plan — the Chat View as an abstraction layer over the Dev View core

- Milestone: [#20 — M13 — Daily Driver: Chat View in Production](https://github.com/adea-ai/adea/milestone/20)
- Seed agenda: [#481](https://github.com/adea-ai/adea/issues/481) (this document is that planning pass's deliverable)
- Certification gates: [#42](https://github.com/adea-ai/adea/issues/42) and [#130](https://github.com/adea-ai/adea/issues/130)
- Runtime contract: [Dev Runtime spec](../specs/dev-runtime.md) — "Harness registry and launch", "The runtime-events-v1 stream", "Data classification and redaction", "Performance and retention budgets"
- Session/projection authority: [#400](https://github.com/adea-ai/adea/issues/400) (canonical `RuntimeSession`, canonical event hierarchy, Dev↔Chat projection contract, root-default policy)
- Coordination format: [M12 dispatch plan](m12-dispatch.md); decision-layer boundary: adea-ai/control-plane#558, entitlements: adea-ai/control-plane#552
- Architecture: [ADR 0009](../decisions/0009-dev-view-control-plane.md)

## Outcome

Adea's Chat View becomes the owner's daily driver: every chat conversation is
one canonical `RuntimeSession` from #400 — never a second process, never a
second conversation object — rendered as a consumer-simple surface
(composer, streaming transcript, approvals, steering) over the same
projects/groups registry the Dev View sidebar already serves. Two audiences
work on the same layer: the consumer gets `Agent: <profile>` + `Mode: Auto`
and a zero-config first run (managed Pi default from #31 under #400's
root-default policy); the developer gets #400's explicit harness/model/runtime
pins as `Mode: Customize` on the same composer.

The milestone exits when the owner runs real daily agent work through Adea
chat in production with no fallback to previous tools (#42/#130 hold the
cross-product certification; M14 — #475 — gates on this milestone closing).

## What this plan does NOT do

Standing owner directives; a slice PR that crosses these lines is wrong:

1. **No harness engineering.** Chat code never rewrites prompts, never
   compacts, never injects context, never intercepts tools. Policy _selects_;
   the harness _executes_ (#400 ownership boundary, control-plane#558).
2. **No Control-Plane-side work.** The decision layer that resolves
   harness/model/skills/tools/runtime/sandbox/context-package/delegation is
   control-plane#558; consumer model-access provisioning is control-plane#552.
   M13 chat is a **consumer** of those pinned contracts — it submits
   resolution inputs and renders resolution outputs, and nothing more.
3. **No second session machinery.** No chat-owned conversation store, no
   chat-owned process, no chat-owned event log, no relay of terminal bytes
   into an unbounded structured store. The canonical event log and
   `HarnessRun` history are the only records.
4. **No virtual/spatial work.** Virtual View stays M17 (#489 gates on M13
   AND M14); the butler dispatches through the same decision layer later.
5. **No remote-runtime work.** Web/mobile chat over a remote
   `RuntimeConnection` certifies in M14 (#475); M13 ships the local packaged
   desktop journey. Slices must not fork the chat surface into a
   remote-specific variant — the same projection is what M14 certifies.

## The conversation identity contract (all slices inherit it)

- **One chat conversation = one canonical `RuntimeSession`.** Creating a
  conversation creates/attaches the session through the staged #400 launch
  transaction (idempotency key, leases, readiness, prompt delivery with
  acknowledgement). Resuming a conversation is resume-as-new-generation under
  the same session. There is no chat-side conversation ID distinct from
  `runtimeSessionId`.
- **The transcript is a projection of the canonical event log**, read through
  `dev.session.events` (`runtime-events-v1`: read-direction grant bound to
  channel/scope/generation, newest-500 replay at attach, live CBOR frames,
  ack-only control frames, `stale_generation` close, bounded windows). Chat
  renders tiers 1–3 of the #400 event hierarchy with truthful provenance; it
  never fabricates semantic state a tier cannot prove.
- **Lifecycle maps onto the existing session state machine**
  (`idle → starting → working ↔ awaiting_input/awaiting_approval →
completed|failed|cancelled|disconnected|unknown`, plus independent
  `stale`). Chat's affordances (send, stop, approve, answer, resume, archive)
  are the existing command surface — `dev.session.*`, `dev.harness.*` — not
  new chat commands.
- **Input authority has one owner at a time.** Chat sends enter through the
  generation-bound write gate as `chat_user`; switching Dev↔Chat never
  pauses, duplicates, or relaunches the harness (#400 Dev↔Chat projection
  test, now from the Chat side).
- **Organization model is shared.** The chat list renders the same
  projects/groups registry (#398) as the Dev View sidebar — the abstraction
  simplifies the session surface, not the organization model (#481 owner
  mapping).
- **Degradation is truthful.** Fallback-only sessions render a visible
  "terminal transcript projection" label with jump-to-terminal; the
  1,000-event/session retention bound is surfaced (older transcript ranges
  report bounded availability — never silently truncated, never re-fetched
  from terminal scrollback into the event store); `auth_required`,
  `stale_generation`, and non-resumable states render as one obvious
  recovery action each.

## Slices

One agent per issue; issues carry the same acceptance criteria as below.

### S1 — Conversation model: one conversation per canonical RuntimeSession (M13.1)

Scope: the chat model layer in `packages/dev-view/src/chat/model/**` —
conversation registry derived from the session registry (no separate store),
session create/attach/resume/cancel/archive flows over the existing
`dev.session.*`/`dev.harness.*` commands, title/status derivation from
canonical events only, transcript window queries over `dev.session.events`
with cursor/`fromSequence` handling and `stale_generation` recovery, and the
input-authority binding that tags chat sends `chat_user` for the write gate.
Additive DTO blocks only in `packages/types/src/dev-runtime.ts` where a chat
view-model needs a typed shape; no new wire operations without a spec change
in the same commit.

Acceptance criteria:

- [ ] Creating a conversation produces exactly one `RuntimeSession` through
      the #400 launch transaction; retry with the same idempotency key never
      duplicates a session, a run, or a prompt.
- [ ] The conversation list is a projection of the session registry and
      projects/groups hierarchy — deleting the session removes the
      conversation; there is no chat-side conversation identity.
- [ ] Resume is new-generation under the same session; archived conversations
      keep history readable (generation binding holds) per the
      `runtime-events-v1` contract.
- [ ] Dev↔Chat switching preserves session ID, sequence, draft, and
      scrollback with no relaunch — the #400 shared-contract test driven from
      the Chat side.
- [ ] Retention bounds are surfaced: reads beyond the retained window report
      bounded availability; no code path copies terminal scrollback into the
      event store.
- [ ] Unit/integration tests cover create/attach/resume/cancel/archive,
      duplicate-event dedupe, sequence-gap resync, and `stale_generation`.

### S2 — Chat surface: composer, transcript, and streaming (M13.2)

Scope: the chat surface components in `packages/dev-view/src/chat/**` (above
the S1 model layer) — composer (send/steer/stop, disabled-with-reason states),
transcript rendering of the canonical event hierarchy (turns, condensed
tool/thought events, approvals, questions, subagents), streaming attachment
via `runtime-events-v1` through the desktop bridge, status/header truth from
the canonical state machine, approvals and steering inline, jump-to-terminal,
and the visible "terminal transcript projection" label for fallback-only
sessions. Donor composition (KiroCrew chat/goal-loop UX) is the visual spec;
port composition into Solid/Adea tokens.

Acceptance criteria:

- [ ] Streaming replies render from `runtime-events-v1` frames with
      attach-replay + live push, ack flow, and reconnect/resync — a dropped
      frame window recovers from the event log, never from a chat-side cache.
- [ ] Approvals, questions, and steering work end-to-end against #400
      fixtures (native/ACP, authenticated-hook, and PTY-fallback tiers);
      fallback-only sessions show the truthful label + jump-to-terminal.
- [ ] The composer is disabled-with-reason (not hidden) for non-owned input
      authority, awaiting-approval holds, and disconnected sessions.
- [ ] Chat's initial graph contains no xterm/CodeMirror/browser code
      (spec performance budget); the dev-view chunk ratchet stays green or is
      re-ratcheted with measurement in the same PR.
- [ ] Secrets/private paths are redacted per the spec's data classification
      before any chat render; harness-supplied strings render as
      size/depth/rate-limited text, never as markup.
- [ ] Visual-lane fixtures cover transcript states (streaming, approval,
      fallback label) deterministically.

### S3 — Auto mode: the decision-layer consumer client (M13.3)

Scope: the consumer mode surface in
`packages/dev-view/src/chat/composer/**` — `Agent: <profile>` +
`Mode: Auto | Customize`. Auto submits the control-plane#558 resolution
contract's inputs (objective, AgentProfile, available runtimes, entitlements,
workspace state, required capabilities, cost/latency preferences) to the CP
decision layer and renders the resolved launch parameters through the same
staged #400 launch transaction; Customize exposes #400's developer surfaces
(harness/model pickers, per-conversation overrides, favorites/recents — zeron
composer-preferences donor pattern) as explicit pins; unpinned outputs still
resolve through the same layer. Chat never resolves locally and never
overrides an explicit pin. If the CP contract or entitlements (control-plane#552)
are not yet pinned, the slice pins the adea-side request/reply types, renders
`auth_required`/`unavailable` truthfully, and leaves the developer path fully
functional — it does not fork a local resolver.

Acceptance criteria:

- [ ] Auto mode resolves only through the CP decision-layer contract; no
      chat-side harness/model selection logic exists (code inspection is an
      acceptance test).
- [ ] Auto launch uses the same launch transaction and idempotency rules as
      explicit launches; resolution failures render typed remediation, never
      a silent fallback to a default harness.
- [ ] Customize pins are authoritative: an explicit harness/model choice
      survives policy application unchanged (#400: policy applies without
      overriding explicit choices).
- [ ] Entitlement-absent states (control-plane#552 undecided) render one
      obvious action and never block the developer path or crash the surface.
- [ ] Composer preferences (mode, agent, favorites, recents) persist per
      user/project without persisting credential values.

### S4 — First-run onboarding: the zero-config "mom flow" (M13.4)

Scope: the first-run flow (onboarding modules under
`packages/dev-view/src/chat/onboarding/**` plus its shell entry points) —
sign in or guest → managed Pi default → first conversation streaming in chat,
with zero harness choices surfaced. The managed-Pi install lifecycle (#31,
closed) and #400's root-default policy supply the default; install progress,
auth-required states, and failure states each translate into exactly one
obvious action (typed remediation from the M10/#31 error contract). bb's
thread-creation flow and KiroCrew's goal-loop start are the cited donor
precedents for composition.

Acceptance criteria:

- [ ] Clean-desktop E2E: fresh profile → sign in or guest → managed Pi
      installs (or is already present) → first conversation streams in chat
      with no harness/model/runtime choices presented.
- [ ] Every blocking state (auth required, install failure, discovery miss,
      incompatible version) renders one obvious action with typed remediation;
      no state dead-ends or surfaces raw diagnostics as the primary UI.
- [ ] Discovered user-installed harnesses enter the ordering only through user
      action; reset-to-discovered restores managed-Pi-first (#400 root-default
      policy verified from the onboarding path).
- [ ] The journey re-runs green on the packaged macOS build (evidence into
      the `test:packaged` lane artifacts).
- [ ] Guest sessions work or gate cleanly per the control-plane#552 decision;
      the flow degrades truthfully if model access is unprovisioned.

### S5 — Daily-driver conversation features: history, search, notifications (M13.5)

Scope: the #481 "consumer features inventory" decomposed against the
canonical event hierarchy — searchable conversation/run history over
`dev.harness.runs` (newest-first, cursor pages) and the event log (bounded
windows, not a second index), conversation resume/continue affordances,
desktop notifications for `awaiting_input`/`awaiting_approval`/completion on
backgrounded conversations, and transcript export. History/search render the
same redaction rules as the live transcript. Notifications are presentation
signals derived from canonical state transitions — never a chat-side
state watcher.

Acceptance criteria:

- [ ] History search covers prompts, result summaries, tool/approval/question
      events, and statuses across sessions with jump-to-session and
      jump-to-event, paged/virtualized per the spec's row budgets.
- [ ] Search reads only authoritative stores (`HarnessRun` records, canonical
      event windows); no second transcript index or store is introduced.
- [ ] Notifications fire from canonical state transitions only, respect
      focus/authority (no notification storm while the surface is focused),
      and are redacted (no prompt/tool content in the notification body).
- [ ] Resume-from-history re-enters the same `RuntimeSession`
      (new generation) or reports explicit non-resumability.
- [ ] 1,000 project/session rows remain virtualized in the chat list
      (spec performance budget).

### S6 — M13 certification path: chat daily-driver evidence (M13.6)

Scope: the adea-side readiness package for #42/#130 — the complete chat owner
journey (onboard → converse → approve → steer → resume → search → archive)
proven on the packaged macOS desktop; Dev↔Chat projection proofs re-run from
the Chat side; accessibility pass on the chat surface; chat added to the
performance budgets and 24-hour soak records; evidence into the named lanes
(`test:packaged`, `test:security:dev-runtime`, `test:performance:dev-runtime`,
`test:soak:dev-runtime`, visual lane). The cross-product certification runs
in #42/#130 themselves (they require the Control Plane release candidate —
external to this repo); this slice closes only when every chat-side input
those gates consume is green and recorded. Closes last in the milestone.

Acceptance criteria:

- [ ] The chat owner journey passes end-to-end on the packaged build with
      evidence artifacts under `artifacts/` (screenshots, logs, timings).
- [ ] Dev↔Chat repeated-switch proof (no process/session/sequence/draft/
      scrollback loss, no relaunch) recorded on the packaged build.
- [ ] WCAG 2.2 AA audit of the chat surface filed and green (keyboard,
      focus, live-region announcements for streaming text).
- [ ] Performance budgets extended with chat numbers (initial graph, streaming
      render interaction budget) and a 24-hour multi-conversation soak record
      with bounded memory/disk/descriptors.
- [ ] A written chat-side evidence summary exists for #42 and #130, listing
      every chat-side input each gate consumes and where its artifact lives.

## Waves

**Wave A — conversation model first (everything reads it):**

| Agent | Issue                    | Gate to close                                     |
| ----- | ------------------------ | ------------------------------------------------- |
| S1    | M13.1 conversation model | M12 session core landed (#400 merged); standalone |

**Wave B — surface + history (parallel, disjoint paths above the S1 layer):**

| Agent | Issue                              | Extra closure deps                     |
| ----- | ---------------------------------- | -------------------------------------- |
| S2    | M13.2 chat surface                 | S1 merged                              |
| S5    | M13.5 history/search/notifications | S1 merged (fixtures may start earlier) |

**Wave C — consumer modes (build on the merged S2 surface):**

| Agent | Issue                      | Extra closure deps                                                                      |
| ----- | -------------------------- | --------------------------------------------------------------------------------------- |
| S3    | M13.3 auto mode            | S2 merged; CP#558 contract state noted on the issue (adea-side types pin independently) |
| S4    | M13.4 first-run onboarding | S2 merged; #31 lifecycle + #400 root-default policy (landed)                            |

**Wave D — certification evidence (closes last):**

| Agent | Issue                    | Extra closure deps                                            |
| ----- | ------------------------ | ------------------------------------------------------------- |
| S6    | M13.6 certification path | S1–S5 merged; #42/#130 themselves are the cross-product gates |

Branch naming: `feat/m13-<issue>-<slug>`. PRs: draft → ready after local
validation → squash merge into `main`.

## File-ownership map

| Agent | Issue | Owned paths (exclusive while open)                                                                                                                                                         |
| ----- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1    | M13.1 | `packages/dev-view/src/chat/model/**`, additive DTO blocks in `packages/types/src/dev-runtime.ts`                                                                                          |
| S2    | M13.2 | `packages/dev-view/src/chat/**` except `model/**` and `composer/**` + `onboarding/**` (created later), dev-view chat CSS additions, dev-view chunk-budget ratchet when chat code lands     |
| S3    | M13.3 | `packages/dev-view/src/chat/composer/**`                                                                                                                                                   |
| S4    | M13.4 | `packages/dev-view/src/chat/onboarding/**`, shell onboarding entry modules under `apps/desktop/shell/src/**` (new files only; existing shell files append-only with PR-noted coordination) |
| S5    | M13.5 | `packages/dev-view/src/history/**`, `packages/dev-view/src/chat/search/**`, shell notification modules (new files only)                                                                    |
| S6    | M13.6 | `apps/web/e2e/**` chat fixtures, `artifacts/**` lane outputs, scripts/lane wiring for chat evidence                                                                                        |

Shared files — append/coordinate, never rewrite: `packages/types/src/
dev-runtime.ts` (additive DTO blocks only), dev-view CSS additions (own
slice's block), spec `docs/specs/dev-runtime.md` (the slice that changes
behavior owns its same-commit paragraph). Merge order = wave order when these
conflict.

## Rules for every agent

1. Start contract as in [M12 dispatch](m12-dispatch.md): read this plan, the
   Dev Runtime spec, #400, and the slice issue; no design re-discovery; if a
   dependency is absent, record the blocker on the issue and move to another
   dependency-ready slice.
2. **The conversation identity contract above is inviolate.** Any PR that
   introduces a chat-side conversation store, a second process, or duplicate
   prompt delivery fails review regardless of tests.
3. No harness engineering, no CP-side work (see "What this plan does NOT
   do"); unresolved CP contracts are consumed as pinned adea-side types with
   truthful degraded states, never forked locally.
4. Truthful degradation everywhere: labeled fallback projections, bounded
   retention surfaced, typed auth-required states, no fabricated semantic
   chat formatting.
5. Donor composition is the visual spec (KiroCrew chat/goal-loop, zeron
   composer preferences, bb thread creation — all in the donor audit);
   reuse-first per the manifest protocol; Warp AGPL and `hexuria/opengrok`
   remain prohibited.
6. Spec/ADR/manifest/NOTICE changes land in the same commit as the behavior
   that requires them.
7. Every PR records its Bun runtime-version guards (adea#490) and runs the
   repository-valid check battery for its paths.

## Open decisions (recorded, not slice-blocking)

1. **Consumer model-access path** (control-plane#552, open): CP-provisioned
   gateway vs BYOK vs free tier. S3/S4 consume it as typed
   `auth_required`/`unavailable` states until decided; the decision changes
   the mom flow's last step, not its shape.
2. **Transcript durability beyond retention.** The canonical event log bounds
   at 1,000 events/session; a daily-driver transcript older than that stays
   reachable only through terminal scrollback/history summaries unless the
   owner asks for durable export. S5 ships export; S6 records the residual
   gap for the owner rather than inventing a second store.
3. **Where #42's Slack-style conversation scenarios meet M13 chat.** #42's
   canonical-conversation scenario predates the chat-as-abstraction re-order;
   S6's evidence summary states explicitly which #42 scenarios the Chat View
   satisfies via `RuntimeSession` projection and which remain Slack-style-
   surface scenarios, so the certification run does not re-litigate scope.
