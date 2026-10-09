# Management operation routing

- Status: Implemented (2026-10-09), M14.03.1 (adea-ai/adea#1215).
- Scope: how human HTTP controls and workspace lead tools share one authorized
  management surface for configuration, memory, projects, worktrees and
  sessions, how a lead decision is bound to the exact call, and which
  operations stay typed-unsupported until their upstream contract exists.

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
- its **revision** anchor (`workspace_version`, `workspace_order`,
  `memory_revision`, `project_order`, `worktree_generation`,
  `session_generation`, `plan_digest`), **confirmation** style (`none`,
  `explicit`, `plan_commit`), **audit** surface and **recovery** contract;
- the callable state per **lane** (`web`, `desktop`, `lead`), where every
  unsupported lane carries one of the typed reasons below.

## The gateway

`apps/web/src/server/management-gateway.ts` is the single enforcement point.
`createManagementGateway` checks lane support, requires a lead caller to carry
an immutable CP decision **and** the exact-call binding that decision was issued
for, revalidates both against the operation about to run, then authorizes the
same user principal through the same shared authorization API for both human
and lead callers. Authorization failures, stale revisions, conflicts, cleanup
gates and unknown internal errors are projected to bounded typed failures; raw
error text never reaches a caller.

`apps/web/src/server/management-operations.ts` binds each callable operation to
its existing database function. HTTP routes (`apps/web/src/start/routes/...`)
and `apps/web/src/server/lead-management-tools.ts` both construct the same
operations object. Human controls omit the binding; a lead invocation without
the matching binding performs zero authorization and zero executor calls.

## Exact-call lead authority (CP932 coordination contract)

A lead operation is authorized only by a current, immutable, exact-call bound
decision. Nonempty reference strings are not proof: the decision's signed
binding must equal the operation, workspace, target and input digest actually
being executed.

### Binding and digest

`ManagementCallBinding` is `{workspaceId, operation, targetId, inputDigest}`.

- `inputDigest` is `sha256:` over the UTF-8 bytes of the canonical JSON of the
  operation input: plain objects (including objects parsed from JSON) with keys
  sorted by code point, arrays in order, and only JSON-safe scalars (finite
  numbers, strings, booleans, null). `undefined`, bigint, functions,
  non-finite numbers and class instances are rejected, never guessed.
- The canonical operation input is the same object the host call sends:
  `{name}` for a project rename, `{expectedVersion, ...workspaceUpdateFields}`
  for a workspace update, `{projectId, role}` for a project member, and so on.
  `managementCanonicalInput`, `managementInputDigest` and
  `managementCallBinding` in `packages/types/src/management.ts` are the shared
  implementation.

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
    "workspaceId": "…",
    "operation": "project.update",
    "targetId": "… | null",
    "inputDigest": "sha256:<64 lowercase hex>"
  },
  "authorityRevision": 7,
  "issuedAt": "RFC 3339",
  "expiresAt": "RFC 3339"
}
```

Any unknown key, wrong version, malformed field or unusable lifetime is
refused. `validateManagementAuthorityDecision` rechecks the reference identity,
the exact binding, the allowed decision, and currentness (`issuedAt <= now <
expiresAt`, lifetime ≤ 300 s).

### Transport claims (host endpoint)

The private host endpoint `POST /api/internal/pi-durable/management` accepts
the call envelope `{schemaVersion: "adea-management-call/v1", operation,
workspaceId, targetId, input}` plus `Authorization: Bearer <decision JWT>`.
The Ed25519 JWT carries exactly these claims:

`actorUserId, audience, authorityRevision, credentialId, credentialKind,
decision, decisionId, expiresAt, inputDigest, intentId, issuedAt, issuer,
keyId, leadAgentId, operation, principalId, projectIds, scopes, targetId,
workspaceIds`

with `audience: "adea-lead-management"`, `credentialKind: "service"`,
`scopes: ["management:execute"]`, `projectIds: []`, one `workspaceIds` entry
and `decision: "allowed"`. Trust comes only from `PI_LEAD_MANAGEMENT_TRUST`
(`issuer`, `keyId`, `publicJwk`, `principalId`, `workspaceIds`,
`revokedCredentialIds`); revocation, key rotation and workspace changes apply
on the next call. The route recomputes the binding from the body and the
adapter refuses any mismatch with zero executor calls.

### CP932 obligations

The Control Plane side (`adea-ai/control-plane#932`) must:

1. persist exact action/input/target/audience/expiry approvals across restart
   and re-read current grants at issuance;
2. atomically consume a single-use approval before returning it, so a replayed
   decision resolves to nothing (Adea's process-local guard is defense in depth
   only);
3. recheck current authority at execution/publication and never let a prompt or
   persona widen the binding.

This contract was posted to `adea-ai/control-plane#932` for confirmation by the
Luna MAX owner (`01a119c2-4f53-73d6-a80b-39a4fcb4001f`); the Adea-side parser,
validator, verifier and host endpoint are implemented and tested against it.

## Typed unsupported reasons

| Reason                           | Meaning                                                                                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device_required`                | The operation exists only through the authorized local device host (memory, worktrees, sessions, preferences, connections, workspace deletion cleanup). The lead has no remote runtime channel yet.                                    |
| `upstream_authority_unavailable` | The canonical upstream turn/approval authority (control-plane R3/J2) is not released or installed; a lead tool call cannot be executed.                                                                                                |
| `not_implemented`                | No shared implementation or dedicated server-confirmed flow exists yet (for example the currently unused DB-only workspace archive path, and the per-user workspace ordering that is a personal preference rather than a lead action). |

## Typed authority failures

`authority_unavailable`, `authority_malformed`, `authority_binding_mismatch`,
`authority_denied`, `authority_expired`, `authority_not_yet_valid` and
`authority_replay`. Every one is produced without an executor call.

## Regression coverage

- `packages/types/tests/management.test.ts` pins the catalog's shape, the
  `dev.*` bindings against the generated operation registry, the canonical
  digest, the strict decision parser and the exact-call validator.
- `apps/web/test/management-gateway.test.ts` pins human/lead parity, binding
  mismatch for workspace/target/operation/input, identity mismatch, denied,
  expired and future decisions, authorization/audit backend failures, device
  refusal and bounded error projection.
- `apps/web/test/management-operations.test.ts` pins executor wiring, the
  version/order conflict contracts, the dedicated confirmation operations and
  the zero-executor refusal when a lead binding is absent.
- `apps/web/test/lead-management-tools.test.ts` pins that the lead definitions
  are exactly the inventory's lead-callable slice, that the resolver receives
  the exact-call binding, and malformed/expired/replayed decisions.
- `apps/web/test/lead-management-service-auth.test.ts` pins the signed claim
  grammar, trust/revocation, forgery and lifetime rules.
- `apps/web/test/lead-management-route.test.ts` pins the host endpoint,
  strict call parsing, body-tamper refusal and replay refusal.
- `apps/web/test/management-routing-boundary.test.ts` pins that no API route
  imports a management database function directly.

## Remaining integration boundary

The host endpoint, decision parser, verifier and adapter are implemented and
tested against the contract above. Connected execution still requires the
CP932 durable approval store and its decision issuer to be installed and
authorized (an operator `PI_LEAD_MANAGEMENT_TRUST` + CP signing credential),
and the remote runtime-node channel for device-local operations. Until then the
inventory and gateway record the typed refusal rather than substituting a local
grant.
