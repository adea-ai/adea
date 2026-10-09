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
(`deriveDirectSessionHandoff`), `packages/dev-view/src/chat/handoff-controls.tsx`,
optional `handoffView` props on `ChatView`. The view mints no session, run,
or location IDs and switches no worktree, project, or execution location.
Offline, stale generation, control conflicts, scope mismatch, archived
sessions, and missing bound runs each render a named reason with a
remediation — never a silent fallback. Unsent drafts are always preserved.

Reused existing operations only (`docs/specs/dev-runtime-operations.json`):
`dev.session.get`, `dev.session.list`, `dev.session.events`,
`dev.session.cancelHarness` (bound harness run only),
`dev.session.resumeHarness`, `dev.session.archive/unarchive`.
Lead-stop maps to the bound `cancelHarness` control; nothing else is mapped
onto it.

## What Adea does NOT own (Control Plane)

Lead-turn/job/descendant cancellation beyond the bound harness run, plus
native-bridge qualification and budget/progress delivery, remain Control Plane
products. No new `dev.*` operation was added in this slice and no
Control Plane code was edited.

## Exact contract needed from the CP #935 owner

The following must be supplied (versioned, generation-bound, idempotent)
before Adea can enable the currently-disabled job and descendant controls.
Names are the handshake proposal for the CP owner to confirm or replace —
Adea implements against the confirmed contract, not this draft:

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
A23–A25, A33 (this slice: model tests in
`packages/dev-view/tests/chat-handoff-model.test.ts`; no duplicate
execution, no silent fallback, preserved authority).
Related gates: [#40](https://github.com/adea-ai/adea/issues/40),
[#43](https://github.com/adea-ai/adea/issues/43),
[#811](https://github.com/adea-ai/adea/issues/811).
