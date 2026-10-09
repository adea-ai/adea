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

### Canonical host mapping and real route (implemented; remaining binding)

Control-plane `origin/main` (`f735d7ea`) merged PR #1038 (`398a9020`)
so `apps/control-api/src/pi-durable/current-tool-authority.ts` is canonical and
`publicationNow` is present in the production composition. The narrow
authenticated Control API route is implemented on branch
`feat/issue-932-management-current-authority` (head
`40225963219a0bf56ed109067e13104bebe1f726`):

- `POST /v1/pi-durable/management-current/assert`
  (`apps/control-api/src/pi-durable/management-current.controller.ts`),
  service-authenticated with `execution:read`; body is the versioned read
  envelope with operation `pi-durable.management-current.assert` and
  `parameters { request: <canonical tool-call request>, boundary }`; response is
  `{ data: { asserted: true } }`. It is a repeatable pass-through to
  `createPiDurableCurrentToolAuthority().assertCurrent(request, boundary)` that
  never consumes an approval and never returns a truthy grant.
- `apps/control-api/src/models/production-model-composition.ts` now accepts an
  optional top-level `managementAuthority` (governed `service` + `interactions`),
  constructs the canonical authority when present (independent of `children`),
  exposes it as `piDurableCurrentToolAuthority`, and fails closed before
  allocation on a malformed binding. `publicationNow` is preserved.
- `apps/control-api/src/app.module.ts` registers the controller with an
  `UnavailablePiDurableCurrentToolAuthority` default, so a host without the
  authority fails closed.

Adea side (`apps/web/src/server/management-authority-current.ts`) implements the
real client for that route and `applicationManagementCurrentAuthority()` wires
it through the same seam; it refuses when `CONTROL_PLANE_ORIGIN`/signing is
unconfigured, when the credential is unmapped, or when the request carries no
`canonicalRequest`.

Remaining CP-host mapping (reported to root; not edited in another owner's
files):

1. The launcher that builds `ProductionPiLeadCompositionOptions` must supply the
   top-level `managementAuthority` (the same governed
   `PolicyControlledToolExecutionService` and interaction repository); the
   hosted graph lane shows the construction pattern in
   `apps/hosted-control-plane/src/hosted-graph-tool-operations.ts`.
2. The CP host must include the canonical tool-call request in the management
   call and sign a `canonicalRequestDigest` claim covering the exact object
   Adea forwards. The Adea seam now implements that binding: the verifier
   requires the `sha256:` digest claim, the route recomputes it over the body's
   `canonicalRequest` and refuses a mismatch with
   `authority_binding_mismatch`, then forwards the same opaque request to the
   admission assertion and the effect assertion. Adea never constructs or
   interprets the request. The CP decision issuer that emits the claim and the
   management tool effect that posts to Adea remain CP-host work; the
   production-composed Adea test proves the seam against a loopback CP route.

`packages/pi-durable-adapter/src/composition.ts` (`tools.assertAuthority`) and
`packages/pi-durable-adapter/src/effect-gate.ts` consume the authority at the
canonical boundaries; `node-composition.ts` forwards `options.tools`. The
management tool effect itself (a governed tool whose effect posts to Adea) and
the `adea-management-authority/v1` decision issuer remain CP-host work.

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
