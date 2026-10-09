# Management operation routing

- Status: Implemented (2026-10-09), M14.03.1 (adea-ai/adea#1215). Exact-call
  authority aligned with the CP932 owner proposal
  (`01a119c2-4f53-73d6-a80b-39a4fcb4001f`); owner confirmation pending.
- Scope: how human HTTP controls and workspace lead tools share one authorized
  management surface for configuration, memory, projects, worktrees and
  sessions, how a lead decision is bound to the exact call, and how replay,
  current authority and parked awaits are enforced before any effect.
  #1215 edits no shared tool SDK and no production composition; the R2/#935 and
  J1/#1018 owned files are out of scope by construction.

## Why

The parent slice (adea-ai/adea#1176) requires that a lead tool cannot take a
second, unaudited path to a change a human could also make. The first slice
routed both paths through one gateway but still relied on a process-local
replay set and checked the decision only before the awaited authorization and
audit calls. This version replaces the local set with a durable database claim
and asserts current authority on every delivery, immediately before the effect.

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
2. calls the per-delivery current-authority port (CP932 consumption/current
   authority) — absent or throwing means no effect;
3. re-runs the decision time/binding validation **synchronously, immediately
   before the executor**, so a decision that expires or is parked during the
   awaits cannot execute.

`apps/web/src/server/management-operations.ts` binds each callable operation to
its existing database function. HTTP routes and the lead tool surface both
construct the same operations object.

## Exact-call lead authority (CP932 alignment)

`ManagementCallBinding` is
`{actionDigest, inputDigest, targetDigest, operation, targetId, workspaceId}`
where each digest is `sha256:` over canonical JSON of `{operation}`, the
operation input and `{targetId}`. Adea recomputes all three from the exact call
and refuses any mismatch.

`ManagementAuthorityDecision` (`adea-management-authority/v1`) carries
`authorityRef`, `decisionId`, `leadAgentId`, `intentId`, the original user
`principal`, the exact `binding`, the accepted-plan pin (`planRef`,
`planRevision`), current authority revision and audience
(`authorityRevision`, `audienceRef`), the durable approval identity
(`approval.interactionId`, `approval.audienceRef`, `approval.expiresAt`) and
`issuedAt`/`expiresAt` (≤ 300 s). The strict parser rejects unknown keys;
`validateManagementAuthorityDecision` checks identity, binding, allowed,
decision and approval currentness; `assertManagementAuthorityCurrent` is the
server-only void-or-typed-throw equivalent of the CP932 `assertCurrent` port.

## Durable consumption and current authority (primary owners)

Two durable boundaries, not a process-local set:

1. **CP current authority on every delivery.**
   `apps/web/src/server/management-authority-current.ts` posts the exact signed
   decision identity (schema `adea-management-current/v1`) to the configured
   `PI_LEAD_MANAGEMENT_AUTHORITY_URL` with
   `PI_LEAD_MANAGEMENT_AUTHORITY_TOKEN`. The CP endpoint must re-read current
   grants/revocation/plan/approval state, atomically consume the single-use
   approval, and answer a bounded `{asserted: true}`. A non-2xx answer, a
   malformed or truthy body, an unreachable endpoint or absent configuration is
   a typed refusal and no effect runs. The route requires this port; the
   gateway repeats it immediately before the executor.
2. **Durable Adea effect claim.** `claimManagementAuthorityDecision` in
   `packages/db/src/management-authority-consumption.ts` (table
   `management_authority_consumptions`) inserts `{decisionId, binding digests,
state: 'claimed'}` before the effect and `completeManagementAuthorityDecision`
   marks `succeeded`/`failed` after it. The unique `decision_id` makes the
   database, not a process, the replay owner: a second worker, a cold restart
   or any in-memory eviction finds the retained row. A retained `succeeded` row
   is a typed `authority_replay`; an interrupted `claimed` row is a typed
   `authority_recovery_required` — never a duplicate effect. Only digests and
   identifiers are persisted.

### `assertCurrent` alignment

| CP932 proposed check                               | Adea decision field / owner                             | Adea enforcement                                                   |
| -------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| Exact accepted-plan pin                            | `planRef` + `planRevision`                              | Strict parse; CP rechecks currentness on every delivery            |
| Original actor                                     | `principal`                                             | Strict parse; authorization principal                              |
| Workspace / current audience                       | `binding.workspaceId` / `audienceRef`                   | Recomputed and compared / CP rechecks on every delivery            |
| Revision and expiry                                | `authorityRevision` / `expiresAt`                       | Strict parse / revalidated synchronously before the effect         |
| Canonical action/input/target digests              | `binding.actionDigest` / `inputDigest` / `targetDigest` | Recomputed from the exact call and compared                        |
| Approval interaction / audience / expiry           | `approval.interactionId` / `audienceRef` / `expiresAt`  | Strict parse / `authority_approval_expired`; consumed per delivery |
| Durable whole-request digest, no raw input/secrets | Audit and claim store only IDs and digests              | No raw input/prompt/credential is written                          |

## Transport claims (host endpoint)

`POST /api/internal/pi-durable/management` accepts
`{schemaVersion: "adea-management-call/v1", operation, workspaceId, targetId,
input}` plus `Authorization: Bearer <decision JWT>` with exactly:
`actionDigest, actorUserId, approvalAudienceRef, approvalExpiresAt,
approvalInteractionId, audience, audienceRef, authorityRevision, credentialId,
credentialKind, decision, decisionId, expiresAt, inputDigest, intentId,
issuedAt, issuer, keyId, leadAgentId, operation, planRef, planRevision,
principalId, projectIds, scopes, targetDigest, targetId, workspaceIds`
(`audience = adea-lead-management`, `scopes = [management:execute]`).

## CP932 obligations

1. Persist exact action/input/target/audience/expiry approvals across restart,
   pin the accepted plan and re-read current grants at issuance.
2. Serve the per-delivery current-authority/consumption endpoint; atomically
   consume the single-use approval and recheck revocation before answering.
3. Recheck current authority at execution/publication; a prompt or persona
   change must never widen the binding.
4. Persist only the validated whole-request digest and identifiers.

## Typed refusals

Unsupported lanes: `device_required`, `upstream_authority_unavailable`,
`not_implemented`. Authority: `authority_unavailable`, `authority_malformed`,
`authority_binding_mismatch`, `authority_denied`, `authority_expired`,
`authority_not_yet_valid`, `authority_approval_expired`,
`authority_recovery_required`, `authority_replay`. Every one performs zero
authorization and zero executor calls where the refusal is pre-effect.

## Regression coverage

- `packages/types/tests/management.test.ts` — catalog, digests, strict parser,
  validator, approval expiry, server-only assertion.
- `apps/web/test/management-gateway.test.ts` — human/lead parity, binding
  mismatch, denied/expired/future decisions, late-authority denial, forced
  timeout during the awaited checks, current-authority throw, missing
  current-authority owner, bounded error projection.
- `apps/web/test/management-operations.test.ts` — executor wiring, conflict
  contracts, zero-executor refusal without a lead binding, and digest-only lead
  audit with a canary secret.
- `apps/web/test/lead-management-tools.test.ts` — lead-callable slice, exact
  binding handed to the resolver, malformed/expired decisions.
- `apps/web/test/lead-management-service-auth.test.ts` — signed claim grammar,
  trust/revocation, forgery, lifetimes and approval expiry.
- `apps/web/test/lead-management-route.test.ts` — host endpoint, strict call
  parsing, body-tamper refusal, durable replay and recovery refusals, revoked
  current authority on a later delivery, per-delivery ordering, and completion
  failure.
- `apps/web/test/management-authority-current.test.ts` — real loopback HTTP
  client: exact binding, revocation, malformed/truthy answers, unreachable
  endpoint, parked timeout.
- `packages/db/tests/integration/management-authority-consumption.test.ts` —
  real disposable PostgreSQL: two independent connections, concurrent claim,
  replay, cold restart, mismatched binding and interrupted-claim reconciliation
  with no second effect.
- `apps/web/test/management-routing-boundary.test.ts` — no API route imports a
  management database function directly.

## Remaining integration boundary

The CP932 current-authority endpoint and its signing/consumption store are the
remaining live prerequisite: `PI_LEAD_MANAGEMENT_AUTHORITY_URL`/`_TOKEN` and
`PI_LEAD_MANAGEMENT_TRUST` must be configured by the operator, and the CP
endpoint must exist. Until then the host fails closed on every delivery while
the durable Adea claim remains the effect-level replay owner. Device-local
operations still await the remote runtime-node channel.
