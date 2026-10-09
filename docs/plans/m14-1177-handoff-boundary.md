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
(`deriveDirectSessionHandoff`, strict run binding, handoff/return guards,
`deriveHandoffModeForSurface` / `deriveHandoffInputFromConversation`
production supplier, single-flight admission with a monotonic view/action
epoch), `packages/dev-view/src/chat/handoff-controls.tsx`, default supplier
plus model-backed actions in `ChatView` (`handoff` config; full `handoffView`
override still wins), `transfer` on `ChatConversationModel`, retained
`coordinationOwner` on `RuntimeSession` written only by the host
`transferInput` handler, and the production enablement in
`apps/web/src/components/desktop-first-run-chat.tsx`.

Coordination semantics: nothing is inferred from a bound run or from
composer input authority — a user-created direct run is not proof of an
explicit handoff, and who may type in a box is a different dimension from
who holds session coordination. The retained coordination holder lives on
the session record itself: `dev.session.transferInput` writes
`coordinationOwner` (`toView` `'dev'` hands coordination to the lead,
`'chat'` returns it to the user) alongside the generation/version bump,
and every later `get`/`list` reply and restart projects it. Absent means
no explicit coordination was ever recorded, and a live session without one
attaches read-only even with a run bound. The transient input-view
routing (`fromView`/`toView`) stays a distinct, unstored concept: the
routing says where input goes next, the owner says who coordinates until
the next explicit transfer. The only paths into a coordinating mode are
the host-projected owner, our unobserved commit (current receipt), or an
explicit caller override — never a default.
The view mints no session, run, or location IDs and switches no worktree,
project, or execution location. Offline, stale generation, control conflicts,
scope mismatch, archived sessions, superseded/foreign/terminal runs, and
missing bound runs each render a named reason with a remediation — never a
silent fallback. Unsent drafts are preserved through transfer, lead-stop,
and failed transfers (pinned against the live model maps, not a flag).

Persisted authoritative transition: `dev.session.transferInput`
(generation- and owner-version-fenced, durable host snapshot,
`session.input_transferred` event, retained `coordinationOwner`).
Handoff and return execute it for real via
`ChatConversationModel.transfer` (exact fenced command, refresh from the
canonical register, drafts untouched); a stale receipt parks an explicit
control conflict scoped to the parked generation (it clears when the
conversation moves past it via refresh, never by blind retry at the same
generation). Late completions are fenced by session identity plus a
monotonic view/action epoch: every session switch and every admitted
start advances it, and a completion applies only while the epoch still
reads its admitted value — so an old A completion can neither mark a
newly selected session nor clear a newer A action's busy state (A-B-A
safe). The ChatView reset fires only on an actual session change, never
on a same-session refresh, which preserves receipts and in-flight
actions. Lead-stop maps to the bound
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
Control Plane code was edited. The session contract was extended within
#1177 with boundary coordination instead: the optional retained
`coordinationOwner` on `RuntimeSession` (written only by the existing
`transferInput`, projected by the existing `get`/`list`, validated on
stored records), specified in `docs/specs/dev-runtime.md` in the same
commit as the behavior.

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
contract/action-machine/epoch-admission tests,
`chat-handoff-transfer.test.ts` exact-command and live-draft-preservation
tests against the real conversation model,
`chat-handoff-supplier.test.ts` retained-owner/receipt/run/draft
derivation tests, `project-session-handoff-journey.test.ts` joined
real-register journey (direct-user → handoff → return → restart with one
retained run/location, generation fencing, corrupt-owner fail-closed),
plus mounted Playwright `apps/web/e2e/direct-session-handoff.spec.ts`
over `e2e/helpers/direct-session-handoff-harness-app.tsx`: read-only
attach default, joined handoff→return with direction proof, single-flight
under force activation, stale/conflict with resolve-then-retry through
re-handoff, newer-ownership takeover, late-completion and ABA busy-state
fences, browser-reload retained coordination, keyboard/focus activation,
assistive-technology tree, narrow/200% text, and reduced motion — the
mounted file on an ephemeral loopback harness server, no backend or
database; no duplicate execution, no silent fallback, preserved authority).

Currency rule (operation/view epoch): coordination comes from our
unobserved commit first, then the host-projected retained owner, then
nothing asserted. A receipt carries its session and committed generation
and applies only while the canonical conversation shows it; an older
receipt against a newer conversation falls back to attachment with a
newer-ownership notice instead of overwriting. Completions additionally
carry the view/action epoch captured at admission: any navigation or
newer admitted start invalidates them. A same-session refresh preserves
receipts and in-flight actions; only an actual session switch resets
them.
Related gates: [#40](https://github.com/adea-ai/adea/issues/40),
[#43](https://github.com/adea-ai/adea/issues/43),
[#811](https://github.com/adea-ai/adea/issues/811).
