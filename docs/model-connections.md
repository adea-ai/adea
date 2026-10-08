# Model metadata and explicit payer disclosure

The workspace model metadata route uses the existing Adea principal and signed
Control Plane credential pathways. It never accepts a reusable provider secret,
runtime authority, caller-selected target, payer assertion or spending grant.
Connection metadata is separate from connector credential administration.

`@adea-ai/api-client/model-connections` defines the product DTOs and a structural
`AgentHqModelConnectionsClient` interface. The existing `AgentHqApiClient`
implements registration/revocation, list, role defaults/get/set, selection
preparation and funding reads.
`@adea-ai/data/model-connections` provides workspace-scoped reactive query and
mutation hooks. Updating defaults uses the accepted revision and idempotency key;
lead, child and direct choices remain independent. A missing choice does not
inherit another role's model or take over a direct/native session.

`POST /api/workspaces/:workspaceId/model-connections` accepts the strict
`{action,input}` product envelope. The actions are `list`, `defaults.get`,
`defaults.set`, `selection.resolve`, `funding.get`, `connections.create` and
`connections.revoke`. Reads require workspace membership. All metadata mutations
additionally require `workspace.update` at request and publication boundaries. Response
publication rechecks workspace authorization, and all responses use private,
no-store caching. Selection resolution prepares immutable metadata; it does not
invoke a model, spend funds, acquire a credential lease or admit execution.

Registration takes only `credentialRef`, `credentialRevision` and an idempotency
key. The reference is the existing cloud-credential metadata's canonical
`credentialId` (`crd_` followed by 26 Crockford characters); no new secret is
accepted or written. A string with a different identity format cannot be
registered. Revocation takes only `connectionRef`, positive `expectedRevision`
and an idempotency key. Both use the existing `credential:write` scope. The
upstream service derives provider/account/auth/provenance from trusted vault
metadata. The product mutation response strips credential/grant/owner internals
and returns no assessed models. Create/revoke mutations invalidate the current
workspace's inventory and defaults; only a subsequent qualified inventory read
can supply model readiness.

## Public SDK and host activation

The server probes the actual installed public SDK's seven model operation
descriptors, request/response schemas and corresponding client methods. It uses
those exported schemas and methods exclusively. Older versions remain inactive;
there is no fabricated API implementation or raw HTTP fallback. The pinned SDK
1.11.0 does not expose these operations.

Host composition must independently supply a qualified execution target. Browser
requests cannot supply or qualify one. Current production route wiring has no
such target, so list/defaults explicitly return `availability: unavailable` and
selection preparation fails closed. No live-provider qualification, credential
configuration, access change or production activation is claimed.

## Funding boundary

Funding reads take only the accepted execution ID, attempt ID and selection
reference/revision. The host must authorize that exact binding against accepted
server records and the current product audience at both request and publication
boundaries. The production route composes the canonical database verifier for
the retained prepared binding, original actor and current workspace/topic/profile
audience. Missing records or database failures deny the read; workspace membership
alone never grants payer disclosure. Public SDK and host-target activation remain
independent prerequisites.

The canonical upstream `model-funding-display/v1` response binds its Control
Plane workspace and all four references. A ready response requires explicit
authenticated `fundingOwner` evidence, provider/model/account/auth/funding source,
authority revision and expiry. Connection ownership or account reference never
substitutes for payer evidence. The product projection verifies the mapped Control
Plane workspace and emits the authorized Adea workspace UUID. Credential, grant,
authorization and payer-evidence references do not enter the product response.

Expired disclosure or revoked authority exposes only the exact binding and a
bounded blocked reason, including when expiry occurs during the final publication
check. The query key includes workspace/execution/attempt/selection/revision;
funding has no retained cache window or automatic retry. Consumers must also
check freshness and the exact current accepted binding before displaying payer
data. A ready disclosure never confers execution or physical-send authority.

## Evidence

Focused tests cover strict request boundaries, existing credential scopes, role
isolation/CAS, wrong-workspace and explicit-override rejection, revocation,
explicit payer evidence, exact accepted funding binding, request/publication
authorization and expiry during publication. Adapter-port fixtures use synthetic
signed service credentials and deterministic metadata; they do not certify an
integrated live Control Plane, runtime or provider.
