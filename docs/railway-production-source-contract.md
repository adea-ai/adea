# The Railway production-source adapter contract

**Scope:** issue #1560. This is the adapter-side contract that PR #1559's
offline, fail-closed Railway production-source planner binds to: the
authoritative, non-secret schema provenance, the normalized shape, and the
refusal rules. It is **offline qualification only** — it is not live provider
acceptance, and nothing here authorizes a Railway login, a credential read, a
production read, a deployment, or any change to production configuration.

## Schema provenance (public, non-secret)

| Field                    | Value                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| Provider                 | Railway                                                                                           |
| Contract                 | the public API reference: the deployments query and the Deployment type                           |
| Source                   | <https://docs.railway.com/reference/public-api> (public, no credential required)                  |
| Retrieved                | 2026-10-21                                                                                        |
| Captured provider output | **no** — the fixtures are normalized placeholders shaped like the published schema                |
| Identity evidence        | **none** — the production project, service and environment are not established in this repository |

The normalized deployment shape binds the four fields the published schema
declares: the deployment identifier, the project, the service and the
environment, plus the creation timestamp. Normalization never invents a
field: a payload that does not carry the declared fields is reported as
malformed.

## Identity and the shipped declaration

The production identity is **not** established by any authorized, non-secret
source available to this repository, so the shipped declaration stays
**explicitly unconfigured**:

```ts
export const UNCONFIGURED_RAILWAY_SOURCE_IDENTITY = {
  configured: false,
  projectId: null,
  serviceId: null,
  environmentId: null,
}
```

Nothing in this repository may set that identity without an authorized source
that names all three identifiers. A later issue may record it; this one
deliberately does not.

## The binding rule and the refusals

A plan binds the deployment history to **all three** identifiers — project,
service and environment. A source in which any deployment does not match all
three is refused in full; a partial match never yields a plan.

| Refusal                 | When                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `identity-unconfigured` | the identity is unconfigured, or it does not name all three identifiers  |
| `identity-mismatch`     | a deployment does not bind the declared project, service and environment |
| `malformed-source`      | the payload does not carry the declared schema fields                    |
| `empty-source`          | the payload carries no deployments                                       |

## Source ownership and the offline/live boundary

The contract lives in `scripts/railway-production-source-contract.ts` and its
conformance suite in `scripts/railway-production-source-contract.test.ts`; both
are offline. The planner that consumes the contract is PR #1559's, and it is
**offline**: its fixtures are normalized placeholders, not captured provider
output. This document, the contract and the suite make no claim that a live
Railway project was read, and no gate here may be read as live provider
acceptance. The conformance cases cover the valid binding and the mismatched
project, service and environment cases, the malformed and empty payloads, the
unconfigured identity, the provenance, and the absence of secret-shaped values
in the contract and the fixtures.

## Reproducing

```sh
bun test scripts/railway-production-source-contract.test.ts
```

No credential, no Railway call, and no production read is involved in that
run.
