# Management operation routing

- Status: Implemented (2026-10-09), M14.03.1 (adea-ai/adea#1215). Exact-call
  authority aligned with the CP932 owner proposal
  (`01a119c2-4f53-73d6-a80b-39a4fcb4001f`); owner confirmation pending.
- Scope: how human HTTP controls and workspace lead tools share one authorized
  management surface for configuration, memory, projects, worktrees and
  sessions, how a lead decision is bound to the exact call, and which
  operations stay typed-unsupported until their upstream contract exists.
  #1215 edits no shared tool SDK and no production composition; the R2/#935 and
  J1/#1018 owned files are out of scope by construction.

## Why

The parent slice (adea-ai/adea#1176) requires that a lead tool cannot take a
second, unaudited path to a change a human could also make. Before this slice,
project and workspace routes called their database functions directly with
their own `authorizeWorkspace` call, and there was no lead tool surface at all.
That made an equivalence claim untestable and left device-local operations with
no explicit "not from here yet" contract.

## The inventory

`packages/types/src/management.ts` is the closed catalog. Each operation names:

- its **domain** (`config`, `memory`, `project`, `worktree`, `session`) and
  **surface** (`cloud` or `device`);
- the exact **existing API** it executes through (`web` handler, desktop bridge
  method, or a `dev.*` Dev Runtime registry operation);
- its **workspace permission** (cloud) or Dev Runtime **capability** (device);
- its **revision** anchor, **confirmation** style (`none`, `explicit`,
  `plan_commit`), **audit** surface and **recovery** contract;
- the callable state per **lane** (`web`, `desktop`, `lead`), where every
  unsupported lane carries a typed reason.

## The gateway

`apps/web/src/server/management-gateway.ts` is the single enforcement point.
`createManagementGateway` checks lane support, requires a lead caller to carry
an immutable CP decision **and** the exact-call binding that decision was issued
for, revalidates both against the operation about to run, then authorizes the
same user principal through the same shared authorization API for both human
and lead callers. Authorization failures, stale revisions, conflicts, cleanup
gates and unknown internal errors become bounded typed failures; raw error text
never reaches a caller.

`apps/web/src/server/management-operations.ts` binds each callable operation to
its existing database function. HTTP routes (`apps/web/src/start/routes/...`)
and `apps/web/src/server/lead-management-tools.ts` both construct the same
operations object. Human controls omit the binding; a lead invocation without
the matching binding performs zero authorization and zero executor calls.

## Exact-call lead authority (CP932 alignment)

A lead operation is authorized only by a current, immutable, exact-call bound
decision. Nonempty reference strings are not proof: the decision's signed
digests must equal the call actually being executed.

### Binding and digests

`ManagementCallBinding` is
`{actionDigest, inputDigest, targetDigest, operation, targetId, workspaceId}`.

- Each digest is `sha256:` over the UTF-8 bytes of canonical JSON
  (`managementCanonicalInput`): plain objects with keys sorted by code point,
  arrays in order, JSON-safe scalars only. `undefined`, bigint, functions,
  non-finite numbers and class instances are rejected, never guessed.
- `actionDigest` = canonical `{operation}`; `inputDigest` = the canonical
  operation input the host call sends; `targetDigest` = canonical `{targetId}`.
- The cleartext `operation`/`targetId`/`workspaceId` let Adea recompute and
  compare the digests; `managementBindingsEqual` compares all six fields.

### Decision

`parseManagementAuthorityDecision` accepts exactly:

```json
{
  "schemaVersion": "adea-management-authority/v1",
  "authorityRef": "…",
  "decision": "allowed | denied",
  "decisionId": "…",
  "leadAgentId": "…",
  "intentId": "…",
  "principal": { "kind": "user", "userId": "…" },
  "binding": {
    "actionDigest": "sha256:<64 lowercase hex>",
    "inputDigest": "sha256:<64 lowercase hex>",
    "targetDigest": "sha256:<64 lowercase hex>",
    "operation": "project.update",
    "targetId": "… | null",
    "workspaceId": "…"
  },
  "planRef": "…",
  "planRevision": 3,
  "authorityRevision": 7,
  "audienceRef": "…",
  "approval": { "interactionId": "…", "audienceRef": "…", "expiresAt": "RFC 3339" },
  "issuedAt": "RFC 3339",
  "expiresAt": "RFC 3339"
}
```

Any unknown key, wrong version, malformed field or unusable lifetime is
refused. `validateManagementAuthorityDecision` rechecks the reference identity,
the exact binding, the allowed decision, decision and approval currentness
(`issuedAt <= now < expiresAt`, lifetime ≤ 300 s, approval not expired).
`assertManagementAuthorityCurrent` is the server-only fail-closed equivalent of
the CP932 `assertCurrent` port: it returns void or throws a typed
`ManagementAuthorityError`; it never returns a truthy grant.

### `assertCurrent` alignment

| CP932 proposed check                                   | Adea decision field                                     | Adea enforcement                                                               |
| ------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Exact accepted-plan pin                                | `planRef` + `planRevision`                              | Strict parse; CP `assertCurrent` rechecks currentness                          |
| Original actor                                         | `principal`                                             | Strict parse; used as the authorization principal                              |
| Workspace / current audience                           | `binding.workspaceId` / `audienceRef`                   | Recomputed and compared / strict parse; CP rechecks current audience           |
| Revision and expiry                                    | `authorityRevision` / `expiresAt`                       | Strict parse / `validateManagementAuthorityDecision`                           |
| Canonical tool-call action/input/target digests        | `binding.actionDigest` / `inputDigest` / `targetDigest` | Recomputed from the exact call and compared; mismatch refuses with zero effect |
| Approval interaction / audience / expiry               | `approval.interactionId` / `audienceRef` / `expiresAt`  | Strict parse / `authority_approval_expired`                                    |
| Durable request digest persisted, no raw input/secrets | Audit carries only IDs and the three digests            | Gateway audit record and workspace events carry no raw input                   |

Plan, audience and approval-interaction currentness are CP-asserted: Adea can
only recompute the call digests and read the signed envelope, so the CP932
`assertCurrent` port remains the production authority check. The effect gate
(CP932/R2 boundary) derives the whole validated durable request digest and
persists only digests and identifiers.

### Transport claims (host endpoint)

The private host endpoint `POST /api/internal/pi-durable/management` accepts
the call envelope `{schemaVersion: "adea-management-call/v1", operation,
workspaceId, targetId, input}` plus `Authorization: Bearer <decision JWT>`.
The Ed25519 JWT carries exactly these claims:

`actionDigest, actorUserId, approvalAudienceRef, approvalExpiresAt,
approvalInteractionId, audience, audienceRef, authorityRevision, credentialId,
credentialKind, decision, decisionId, expiresAt, inputDigest, intentId,
issuedAt, issuer, keyId, leadAgentId, operation, planRef, planRevision,
principalId, projectIds, scopes, targetDigest, targetId, workspaceIds`

with `audience: "adea-lead-management"`, `credentialKind: "service"`,
`scopes: ["management:execute"]`, `projectIds: []`, one `workspaceIds` entry
and `decision: "allowed"`. Trust comes only from `PI_LEAD_MANAGEMENT_TRUST`
(`issuer`, `keyId`, `publicJwk`, `principalId`, `workspaceIds`,
`revokedCredentialIds`); revocation, key rotation and workspace changes apply
on the next call. The route recomputes the binding from the body; the adapter
refuses any mismatch with zero executor calls.

### CP932 obligations

The Control Plane side (`adea-ai/control-plane#932`) must:

1. persist exact action/input/target/audience/expiry approvals across restart,
   pin the accepted plan and re-read current grants at issuance;
2. atomically consume a single-use approval before returning it, so a replayed
   decision resolves to nothing (Adea's bounded process-local guard is defense
   in depth only);
3. recheck current authority at execution/publication through the server-only
   `assertCurrent` port and never let a prompt or persona widen the binding;
4. persist only the validated whole-request digest and identifiers — no raw
   input, prompt, credential or reusable secret.

## Typed unsupported reasons

| Reason                           | Meaning                                                                                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device_required`                | The operation exists only through the authorized local device host (memory, worktrees, sessions, preferences, connections, workspace deletion cleanup). The lead has no remote runtime channel yet.                                    |
| `upstream_authority_unavailable` | The canonical upstream turn/approval authority (control-plane R3/J2) is not released or installed; a lead tool call cannot be executed.                                                                                                |
| `not_implemented`                | No shared implementation or dedicated server-confirmed flow exists yet (for example the currently unused DB-only workspace archive path, and the per-user workspace ordering that is a personal preference rather than a lead action). |

## Typed authority failures

`authority_unavailable`, `authority_malformed`, `authority_binding_mismatch`,
`authority_denied`, `authority_expired`, `authority_not_yet_valid`,
`authority_approval_expired` and `authority_replay`. Every one is produced
without an executor call.

## Regression coverage

- `packages/types/tests/management.test.ts` pins the catalog, registry
  bindings, canonical digest, strict decision parser, exact-call validator,
  approval expiry and the server-only assertion.
- `apps/web/test/management-gateway.test.ts` pins human/lead parity, binding
  mismatch for workspace/target/operation/input, identity mismatch, denied,
  expired and future decisions, authorization/audit backend failures, device
  refusal and bounded error projection.
- `apps/web/test/management-operations.test.ts` pins executor wiring, conflict
  contracts, zero-executor refusal without a lead binding, and that a lead
  audit record carries only IDs and digests (no raw input or canary secret).
- `apps/web/test/lead-management-tools.test.ts` pins the lead-callable slice,
  the exact binding handed to the resolver, and malformed/expired/replayed
  decisions.
- `apps/web/test/lead-management-service-auth.test.ts` pins the signed claim
  grammar, trust/revocation, forgery, lifetimes and approval expiry.
- `apps/web/test/lead-management-route.test.ts` pins the host endpoint, strict
  call parsing, body-tamper refusal and replay refusal.
- `apps/web/test/management-routing-boundary.test.ts` pins that no API route
  imports a management database function directly.

## Remaining integration boundary

The host endpoint, decision parser, verifier, assertion and adapter are
implemented and tested against the aligned contract. Connected execution still
requires the CP932 durable approval store and its decision issuer to be
installed and authorized (an operator `PI_LEAD_MANAGEMENT_TRUST` + CP signing
credential), and the remote runtime-node channel for device-local operations.
Until then the inventory and gateway record the typed refusal rather than
substituting a local grant.
