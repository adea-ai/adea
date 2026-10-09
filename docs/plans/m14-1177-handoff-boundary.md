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
- `coordination_handoff` — explicit generation-bound coordination transfer.
- `returned_to_user` — the lead relinquishes; the user owns the session.

Implementation: `packages/dev-view/src/chat/model/handoff.ts`
(`deriveDirectSessionHandoff`, strict run binding, return-to-user guards,
`deriveHandoffModeForSurface` / `deriveHandoffInputFromConversation`
production supplier, single-flight admission, session-identity late fence),
`packages/dev-view/src/chat/handoff-controls.tsx`, default supplier plus
model-backed actions in `ChatView` (`handoff` config; full `handoffView`
override still wins), `transfer` on `ChatConversationModel`, and the
production enablement in `apps/web/src/components/desktop-first-run-chat.tsx`.

Coordination semantics: while a harness run is bound, the lead holds session
coordination and this surface coordinates (`coordination_handoff`); the
confirmed `dev.session.transferInput` receipt moves coordination to the user
(`returned_to_user`). Composer input authority (who may type in a box) is a
different dimension and is deliberately not consulted: conflating the two
made the production return transition unreachable. With no run bound there
is nothing to coordinate, so a live session attaches read-only until a run
exists. The only path to user-held coordination is a confirmed transfer
receipt or an explicit caller override — never a default.
The view mints no session, run, or location IDs and switches no worktree,
project, or execution location. Offline, stale generation, control conflicts,
scope mismatch, archived sessions, superseded/foreign/terminal runs, and
missing bound runs each render a named reason with a remediation — never a
silent fallback. Unsent drafts are preserved through transfer, lead-stop,
and failed transfers (pinned against the live model maps, not a flag).

Persisted authoritative transition: `dev.session.transferInput`
(generation- and owner-version-fenced, durable host snapshot,
`session.input_transferred` event). Return-to-user executes it for real via
`ChatConversationModel.transfer` (exact fenced command, refresh from the
canonical register, drafts untouched); a stale receipt parks an explicit
control conflict scoped to the parked generation (it clears when the
conversation moves past it via refresh, never by blind retry at the same
generation), and a late completion after a session switch commits nothing
(session-identity fence plus per-session state reset). Lead-stop maps to the bound
`cancelHarness` control. Run binding is strict where run objects exist
(same session, register-bound id, same scope, non-terminal) and falls back
to the register id exactly as `cancelHarness` does where they do not — a
run older than the session generation still binds, because transfers bump
the session without replacing the run.

Existing operations reused (`docs/specs/dev-runtime-operations.json`):
`dev.session.get`, `dev.session.list`, `dev.session.events`,
`dev.session.transferInput` (ownership only), `dev.session.cancelHarness`
(bound harness run only), `dev.session.resumeHarness`,
`dev.session.archive/unarchive`. Lead-stop maps to the bound `cancelHarness`
control; nothing else is mapped onto it.

## What Adea does NOT own (Control Plane)

Lead-turn/job/descendant cancellation beyond the bound harness run, plus
native-bridge qualification and budget/progress delivery, remain Control Plane
products. No new `dev.*` operation was added in this slice and no
Control Plane code was edited.

## Exact contract status with the CP #935 owner (verified 2026-10-09)

Control-plane#935 is still open and `docs/specs/dev-runtime-operations.json`
still carries no durable job-cancel intent, generation-bound retry, or effect
receipt operations — only the pre-existing `dev.session.*` family including
`dev.session.transferInput`. Coordination outcome: Adea implements against
the confirmed existing contract (transfer for ownership, `cancelHarness` for
the bound run) and keeps job and descendant controls disabled with the exact
missing J2/J4 contract named. No `dev.*` operation was invented and no
Control Plane code was edited.

The following must still be supplied (versioned, generation-bound,
idempotent) before Adea can enable the currently-disabled job and descendant
controls. Names are the handshake proposal for the CP owner to confirm or
replace — Adea implements against the confirmed contract, not this draft:

1. **Durable job-cancel intent** — persist cancel intent against the exact
   job attempt/generation; report `pending` until the executor confirms;
   lead-stop must not cancel children. Required fields: job id, attempt,
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

## Coordination

API boundaries are coordinated with the CP #935 owner through the linked
issues. This slice records the handshake above and ships the truthful
disabled states; integration lands when the CP contract is confirmed.

## Traceability

REQ 032, 080–088, 095, 096, 104, 110, 130–136. Tests A12–A14, A18, A21,
A23–A25, A33 (this slice: `chat-handoff-model.test.ts` binding/guard/a11y
contract/action-machine/production-admission tests,
`chat-handoff-transfer.test.ts` exact-command and live-draft-preservation
tests against the real conversation model,
`chat-handoff-supplier.test.ts` mode/run/draft derivation tests, plus
mounted Playwright `apps/web/e2e/direct-session-handoff.spec.ts` over
`e2e/helpers/direct-session-handoff-harness-app.tsx`: reachable production
return, single-flight, stale/conflict/retry, late-completion fence,
keyboard/focus activation, assistive-technology tree, narrow/200% text, and
reduced motion — all on an ephemeral loopback harness server, no backend or
database; no duplicate execution, no silent fallback, preserved authority).
Related gates: [#40](https://github.com/adea-ai/adea/issues/40),
[#43](https://github.com/adea-ai/adea/issues/43),
[#811](https://github.com/adea-ai/adea/issues/811).
