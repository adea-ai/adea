# Management operation routing

- Status: Implemented (2026-10-09), M14.03.1 (adea-ai/adea#1215), pending the
  canonical CP932 host mapping and migration ordering.
- Scope: how human HTTP controls and workspace lead tools share one authorized
  management surface for configuration, memory, projects, worktrees and
  sessions, how a lead decision is bound to the exact call, and how authority,
  currentness, replay and parked awaits are enforced before any effect.
  #1215 edits no shared tool SDK and no production composition; the R2/#935 and
  J1/#1018 owned files are out of scope by construction.

## Why

The parent slice (adea-ai/adea#1176) requires that a lead tool cannot take a
second, unaudited path to a change a human could also make. The first slice
routed both paths through one gateway. Later repairs made the exact-call
binding, moved replay to a durable database claim, and added current-authority
assertions at admission and immediately before the effect.

## The inventory

`packages/types/src/management.ts` is the closed catalog: domain, surface, the
exact existing API binding, permission or Dev Runtime capability, revision
anchor, confirmation style, audit surface, recovery contract and per-lane
callable state, with typed unsupported reasons.

## The gateway

`apps/web/src/server/management-gateway.ts` is the single enforcement point.
For a lead caller it validates the immutable CP decision and its exact-call
binding at entry, authorizes, audits, then:

1. re-runs the authorization check **after** the awaited authorize/audit (a
   membership revocation during those waits stops the effect);
2. calls the current-authority seam at the canonical `effect` boundary;
3. re-runs the decision time/binding validation **synchronously, immediately
   before the executor**.

`apps/web/src/server/management-operations.ts` binds each callable operation to
its existing database function. HTTP routes and the lead tool surface both
construct the same operations object.

## Exact-call lead authority

`ManagementCallBinding` is
`{actionDigest, inputDigest, targetDigest, operation, targetId, workspaceId}`
where each digest is `sha256:` over canonical JSON of `{operation}`, the
operation input and `{targetId}`. Adea recomputes all three from the exact call
and refuses any mismatch.

`ManagementAuthorityDecision` (`adea-management-authority/v1`) carries the
exact binding, the original user principal, the accepted-plan pin, authority
revision and current audience, the durable approval identity, and bounded
expiry. The strict parser and validator check shape, identity, binding,
allowed/denied and time; `assertManagementAuthorityCurrent` is the server-only
void-or-typed-throw equivalent used locally.

## Canonical current-authority integration

The canonical Pi Durable owner is **control-plane PR #1038, commit
`ed942840df125385e329f1af4d16c4699ec57fd5`**:
`apps/control-api/src/pi-durable/current-tool-authority.ts` exports
`createPiDurableCurrentToolAuthority(...).assertCurrent(request, boundary)`
with boundaries `'admission' | 'approval' | 'effect' | 'publication'`. It is a
server-only, **repeatable** currentness check: it resolves `void` or throws
`PI_TOOL_AUTHORITY_REJECTED`, re-reads the accepted plan, actor, audience,
grant, call and approval, and never returns a truthy authorization value. The
Pi effect gate owns the durable request digest/replay fence.

Adea does not invent a wire protocol for it. The Adea seam
(`ManagementCurrentAuthority`) mirrors the canonical signature and boundary
names:

- the route asserts at `admission` before creating the durable claim;
- the gateway asserts at `effect` immediately before the executor;
- both calls are repeatable and consume nothing;
- the durable Adea claim below is the single single-use owner.

### Required thin host mapping (reported to root; not edited here)

Upstream context: control-plane `0f380a3c` (the published #1018/#1041 wiring
that merges PR #1038) already imports
`createPiDurableCurrentToolAuthority`, but builds it and passes
`tools: { service, assertAuthority: currentToolAuthority.assertCurrent }`
**only when `options.children` exists**; a standalone workspace lead still has
no canonical tool authority. Also absent at `0f380a3c`: any
`lead-management` / `pi-durable/management` / `adea-management-authority`
reference, so the management tool effect and decision issuer do not exist yet.
The exact mapping needed, for the CP owner:

1. `apps/control-api/src/models/production-model-composition.ts`:
   - hoist the governed tools
     (`Pick<CreatePiDurableCurrentToolAuthorityOptions, 'service' | 'interactions'>`)
     from `options.children.tools` to a top-level optional option;
   - construct
     `createPiDurableCurrentToolAuthority({ currentExecutionAuthority: canonical.executionAuthority, intents, executions, plans, service, interactions })`
     whenever `tools` is present, independent of `children`;
   - pass `tools: { service, assertAuthority: currentToolAuthority.assertCurrent }`
     to `createNodePiDurableLeadComposition` for the standalone lead as well as
     the children path;
   - extend the `PI_PRODUCTION_BINDING_REQUIRED` validation with the
     `service.execute` / `interactions.get` checks;
   - the launcher that builds `ProductionPiLeadCompositionOptions` must supply
     the top-level `tools`; the hosted graph lane builds the same kind of
     governed service in
     `apps/hosted-control-plane/src/hosted-graph-tool-operations.ts`;
   - merge conflict with this branch's clock fix (CP `493d5ddc`): `0f380a3c`
     still passes `options.admission.now` to `PiLeadPublicationService`; the
     merged result must keep `options.publicationNow` (live publication clock)
     from the clock fix.
2. `packages/pi-durable-adapter/src/composition.ts` (`tools.assertAuthority`)
   and `packages/pi-durable-adapter/src/effect-gate.ts` consume that port at the
   canonical boundaries; `apps/control-api/src/pi-durable/node-composition.ts`
   already forwards `options.tools`.
3. Register the management tool effect through that same governed service: the
   effect gate must call `assertCurrent(request, 'effect')` immediately before
   the HTTP call, then issue the signed `adea-management-authority/v1` decision
   bound to the exact call (action/input/target digests, original actor,
   workspace, current audience, revision, approval interaction/audience/expiry)
   and post it to Adea. Adea verifies it, claims the durable effect once, and
   does not call back into CP.

Until this mapping is installed, the Adea production port is fail-closed
(`applicationManagementCurrentAuthority` throws `authority_unavailable`) and no
lead effect runs.

## Durable effect claim

`claimManagementAuthorityDecision` in
`packages/db/src/management-authority-consumption.ts` (table
`management_authority_consumptions`, migration 0045 provisionally) inserts
`{decisionId, binding digests, state: 'claimed'}` before the effect;
`completeManagementAuthorityDecision` marks `succeeded`/`failed` after it. The
unique `decision_id` makes the database the replay owner across workers, cold
restarts and eviction. A retained `succeeded` row is `authority_replay`; an
interrupted `claimed` row is `authority_recovery_required` and is **never**
retried automatically — a duplicate effect is impossible and a fresh authorized
decision (or operator reconciliation) owns the retry. Only digests and
identifiers are persisted.

## Typed refusals

Unsupported lanes: `device_required`, `upstream_authority_unavailable`,
`not_implemented`. Authority: `authority_unavailable`, `authority_malformed`,
`authority_binding_mismatch`, `authority_denied`, `authority_expired`,
`authority_not_yet_valid`, `authority_approval_expired`,
`authority_recovery_required`, `authority_replay`.

## Regression coverage

- `packages/types/tests/management.test.ts` — catalog, digests, strict parser,
  validator, approval expiry, server-only assertion.
- `apps/web/test/management-gateway.test.ts` — human/lead parity, binding
  mismatch, denied/expired/future decisions, late-authority denial, parked-await
  expiry, canonical `effect` boundary assertion, current-authority throw,
  missing owner, bounded error projection.
- `apps/web/test/management-operations.test.ts` — executor wiring, conflict
  contracts, zero-executor refusal without a lead binding, digest-only lead
  audit with a canary secret.
- `apps/web/test/lead-management-tools.test.ts` — lead-callable slice, exact
  binding handed to the resolver, malformed/expired decisions.
- `apps/web/test/lead-management-service-auth.test.ts` — signed claim grammar,
  trust/revocation, forgery, lifetimes and approval expiry.
- `apps/web/test/lead-management-route.test.ts` — strict call parsing,
  body-tamper refusal, durable replay and recovery refusals, revoked admission,
  per-delivery ordering (`admission` before claim), completion failure.
- `apps/web/test/management-production-composition.test.ts` — **production
  composition** (real operations, real verifier, real DB, real claim), run with
  an isolated `DATABASE_URL` and `--conditions=react-server`: authorized update
  succeeds with `admission`/`effect` boundaries, replay is refused with no
  second effect, revocation refuses with zero effect and no burned claim.
- `packages/db/tests/integration/management-authority-consumption.test.ts` —
  real PostgreSQL, two connections + restart: one claim/effect, concurrent
  claim recovery, replay, mismatched binding, interrupted-claim reconciliation.
- `apps/web/test/management-routing-boundary.test.ts` — no API route imports a
  management database function directly.

## Migration ordering gate

`origin/main` currently ends at `0044_lead_turn_runtime`. Adea #1233/#1213 is
selected to land `0045_agent-edit-revisions` first. The `0045_management_authority_consumption`
migration on this branch is **provisional** and must be regenerated on updated
main after that landing (next authoritative free number), coordinated with root
before publication. No migration is claimed to have landed.

## Remaining boundary

The canonical CP host mapping above and the authoritative migration number are
the remaining integration gates. Device-local operations still await the remote
runtime-node channel.
