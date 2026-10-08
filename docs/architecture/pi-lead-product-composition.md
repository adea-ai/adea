# Workspace lead product composition

The workspace lead routes create their runtime dependencies from the authorized
Adea workspace's mapped Control Plane workspace. They use the actual installed
SDK operations and schemas. An older SDK, missing operator configuration, or a
missing workspace mapping leaves the existing durable intent and transcript
available while execution remains blocked.

`PI_DURABLE_LEAD_ENABLED=true` and an explicit `PI_DURABLE_LEAD_TARGET` JSON destination opt this server into the composition. The supported first destination is `remote_host` / `pi_durable` / `1.1.0` / `pi_durable_models`. This describes the requested destination; readiness is always supplied by current CP authority. It does not
create credentials, service scopes, grants, model connections, or payer authority.
The existing Control Plane origin and signing configuration must already be
configured and authorized. The CP service must install the trusted current-product,
immutable profile, model selection, recorded payer, and current authority ports.
The installed public SDK must export prepare, lookup, dispatch, status, progress,
cancel, funding, and current publication operations with their request/response
schemas. Until those released contracts are available, this code remains inactive.

Preparation admits the canonical intent without inference. Explicit dispatch uses
its retained preparation reference, rereads current funding, and relies on CP's
immutable per-attempt full payer confirmation and physical-send authority checks.
A changed payer cannot silently replace that confirmation. Public commands contain
only intent, preparation, dispatch, or cursor references; the original human is
resolved from the canonical DB intent separately from the signed CP service caller.

Publication runs inside the existing Adea transaction holding current actor,
audience, lead, profile, channel, message and runtime locks. CP's current-publication
operation must check its retained canonical execution, attempt, session, selection,
payer and current CP principal/grants without calling back into Adea. This avoids
reciprocal database lock waits. Adea requires every returned reference, original
actor and exact output digest to match, with a finite unexpired authority revision.
The digest is SHA-256 of the exact UTF-8 answer text, including trailing whitespace,
prefixed with `sha256:`. Missing or denied authority withholds the output; it is
never inferred from a completed status or funding read. The timeline append and
publication receipt stay in the same canonical DB transaction.

Focused injected-port tests verify fail-closed configuration, scoped reference
commands, current funding binding and publication pin/digest rejection. These are
unit tests with synthetic signing keys, not a deployed service, real account,
physical device, or live model qualification. Actual authenticated current-product
and publication integration require the separately owned CP production contracts
and a fresh route-to-database integration proof.

The private callback is `POST /api/internal/pi-durable/lead-product/current`. Its
strict body is `{workspaceId,intentId,principalId}`. A fresh signed service JWT
must have audience `adea-lead-product`, kind `service`, `execution:read`, no project
IDs, and exactly the requested workspace. `PI_LEAD_PRODUCT_TRUST` is required
public trust JSON containing issuer, keyId, publicJwk, principalId, workspaceIds,
and revokedCredentialIds. Trust and revocation are reread around verification.
There is no shared-bearer fallback or browser-cookie authority.

`PI_LEAD_PRODUCT_INTENT_LIFETIME_MS` is a required integer between 60,000 and
300,000. Evidence expiry is the canonical intent creation time plus that policy;
reads never renew it. Expired intents require a new authorized user turn. The
reader supplies canonical profile ID/version/revision, and CP's required trusted
immutable profile resolver supplies its digest. No profile or selection pins are
borrowed from a fixture. These settings are code-level deployment prerequisites;
this change creates no signing key, trust entry, grant, or credential.
