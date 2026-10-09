# M14.04 handoff boundary — Adea #1177 with Control Plane #935

- Adea issue: [#1177](https://github.com/adea-ai/adea/issues/1177) — direct-session handoff and job controls.
- Control Plane counterparts: [J2 #935](https://github.com/adea-ai/control-plane/issues/935) (cancellation/effects),
  [J3 #936](https://github.com/adea-ai/control-plane/issues/936) (native bridges),
  [J4 #937](https://github.com/adea-ai/control-plane/issues/937) (budgets/progress).
- Adea dependencies: [#1173](https://github.com/adea-ai/adea/issues/1173) (first lead-to-child journey),
  [#1176](https://github.com/adea-ai/adea/issues/1176) (unified management; executable children
  [#1215](https://github.com/adea-ai/adea/issues/1215) / [#1218](https://github.com/adea-ai/adea/issues/1218)).
- Out of scope for this slice: [#1211](https://github.com/adea-ai/adea/issues/1211) chooser/composer
  production selection, and the external global directory.

## What this slice owns (Adea)

Presentation states over one preserved canonical `RuntimeSession`, its
transcript, its bound harness run, and its accepted execution location:

- `attached` — read-only session reference; grants no control.
- `one_time_review` — a single review pass; takes no control, starts no work.
- `coordination_handoff` — an explicitly observed live lead turn coordinates.
- `returned_to_user` — the observed lead turn ended; the user owns the session.

Implementation: `packages/dev-view/src/chat/model/handoff.ts`
(`deriveDirectSessionHandoff`, strict run binding, lead/session guards,
`deriveHandoffModeForSurface` / `deriveHandoffInputFromConversation`
production supplier, single-flight admission with a monotonic view/action
epoch), `packages/dev-view/src/chat/handoff-controls.tsx`, default supplier
plus model-backed actions in `ChatView` (`handoff` config; full `handoffView`
override still wins), and the production enablement in
`apps/web/src/components/desktop-first-run-chat.tsx`.

Coordination semantics: coordination comes only from supplied canonical
lead-turn facts — the workspace lead's admitted intent identity plus its
observed live execution — and never from a bound run, composer authority,
or view routing. The turn counts only when bound to the observed workspace
lead agent (`HandoffLeadAgent`: designated `isWorkspaceLead`,
workspace-scoped, active lifecycle): the model checks
`turn.agentId === lead.id` plus designation and lifecycle, and an unbound
turn is stripped before derivation so it can neither drive a mode nor
authorize lead-stop — the mismatch is named instead. A caller that can
observe turns (lead-turn reads) observes the agent through the same
canonical roster (`getWorkspaceLead`); the check forces the full chain,
so no run-as-lead alias can pass. A user-created direct run is execution, not delegation:
launching or running never establishes lead coordination, and an ordinary
chat<->Dev View input switch (`dev.session.transferInput`, which keeps its
exact prior semantics and records nothing) never hands off. Stopping the
LEAD cancels the canonical lead turn through the caller-supplied handler;
stopping the SESSION run cancels the bound harness run; job and descendant
cancellation stay disabled pending their Control Plane contracts. No
dev-side coordination is invented, stored, or inferred anywhere: a live
session without explicitly observed lead-turn facts attaches read-only
even with a run bound.

## What Adea does NOT own (Control Plane and lead admission)

Lead-turn admission, dispatch, execution, and cancellation live with the
workspace lead and the Control Plane lead-turn domain (intents keyed
`lead-turn:<id>`, dispatch/execution/attempt identity, cancellable versus
terminal states per the canonical contract). Session-side handoff and
return have no authorized coordination path from the dev surface, so both
rows fail closed with this gap named instead of performing a view
relabel. No new `dev.*` operation was added in this slice and no Control
Plane code was edited; the earlier slice's `transferCoordination`
experiment and its retained fields were fully reverted (operations
registry, generated metadata, host handler, session DTO, spec text) once
review established that the desktop host cannot resolve lead identity or
lead acceptance.

## Exact contract status with the CP #935 owner (verified 2026-10-09)

Control-plane#935 is still open and `docs/specs/dev-runtime-operations.json`
carries no durable job-cancel intent, generation-bound retry, or effect
receipt operations. Coordination outcome: Adea implements against
confirmed existing contracts only (`transferInput` for view routing,
`cancelHarness` for the bound run, lead-turn reads/cancel owned by their
canonical paths) and keeps job and descendant controls disabled with the
exact missing J2/J4 contract named. No `dev.*` operation was invented and
no Control Plane code was edited.

The following must still be supplied (versioned, generation-bound,
idempotent) before Adea can enable the currently-disabled job and descendant
controls. Names are the handshake proposal for the CP owner to confirm or
replace — Adea implements against the confirmed contract, not this draft:

1. **Durable job-cancel intent** — persist cancel intent against the exact
   job attempt/generation; report `pending` until the executor confirms;
   lead-stop does not cancel children. Required fields: job id, attempt,
   generation, idempotency key, actor, reason; reply: intent receipt with
   `pending`/`confirmed` state.
2. **Generation-bound retry** — reconcile uncertain effects before retry;
   fence late old-attempt events from current state and publication.
3. **Approval-before-effect** — stable effect keys, retained receipts, and
   exact current approvals checked before every protected effect.
4. **Attribution and notify** — durably attribute direct child commands and
   notify the coordination owner; cover races, redelivery, and
   crash-after-effect (tests A16–A20).

J3 (#936) and J4 (#937) contracts (qualified native routes, transport
fencing, transactional child budgets, coalesced progress) are tracked by
their owners and are not preconditions for this presentation slice beyond
the disabled states above.

Production wiring (`apps/web/src/lib/lead-handoff-supply.ts`,
`desktop-first-run-chat.tsx`): for the selected session's cloud task id,
the chat host resolves the designated lead (`getWorkspaceLead`), the one
active direct channel referencing both that lead and that task
(`listChannels` filtered by lead agent plus task id), and that channel's
turn (`getChannelLeadTurn`), then maps the observed facts onto the
handoff supply and binds lead-stop to `cancelLeadTurn`, refreshing local
facts from the cancel receipt. The shared task id is the retained
session↔lead relationship both sides already persist (task-scoped dev
sessions carry it; task-scoped lead channels carry it); channels for
other tasks are irrelevant, so several lead conversations elsewhere
never disable an explicitly linked handoff. A session without a task
costs zero reads; a missing link, an ambiguous task link, a missing
turn, or any transport failure resolves to an explicit `unresolved`
reason and the surface attaches with the gap rows. Resolution re-runs
per selected session/task key under a monotonic epoch plus the existing
lifecycle fence, so overlapping resolutions and post-cancel reads apply
in order and a late response can never overwrite newer facts. A
lead-aware host (Dev entry or a channel-bound surface) can supply the
same facts plus the canonical cancel handler through the existing
`handoff` config; until then the gap rows state exactly this.

## Coordination

API boundaries are coordinated with the CP #935 owner through the linked
issues. This slice records the handshake above and ships the truthful
disabled states; integration lands when the CP contract is confirmed.

## Traceability

REQ 032, 080–088, 095, 096, 104, 110, 130–136. Tests A12–A14, A18, A21,
A23–A25, A33 (this slice: `chat-handoff-model.test.ts` lead-turn modes,
binding/replacement matrix, gap rows, a11y contract, action-machine and
epoch admission; `chat-handoff-supplier.test.ts` lead-fact derivation;
`chat-conversation-model.test.ts` session-cancel targeting plus live
draft preservation; `project-session-handoff-journey.test.ts` joined
real-register view-routing journey with reload persistence and fencing;
mounted Playwright `apps/web/e2e/direct-session-handoff.spec.ts` over
`e2e/helpers/direct-session-handoff-harness-app.tsx`: read-only attach
default, observed-turn journey with distinct lead/session stops,
single-flight, replacement retargeting, late-completion and ABA busy
fences, reload of re-read facts, keyboard/focus, AT tree, narrow/200%
text, reduced motion — the mounted file on an ephemeral loopback
harness server, no backend or database; no duplicate execution, no
silent fallback, preserved authority).

Currency rule (operation/view epoch): completions carry the view/action
epoch captured at admission — every session switch and every admitted
start advances it, so late completions commit nothing once replaced
(A-B-A safe). A same-session refresh preserves facts and in-flight
actions; only an actual session switch resets them.
Related gates: [#40](https://github.com/adea-ai/adea/issues/40),
[#43](https://github.com/adea-ai/adea/issues/43),
[#811](https://github.com/adea-ai/adea/issues/811).
