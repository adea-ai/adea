# Workspace lead product composition

The workspace lead routes create their runtime dependencies from the authorized
Adea workspace's mapped Control Plane workspace. They use the actual installed
SDK operations and schemas. An older SDK, missing operator configuration, or a
missing workspace mapping leaves the existing durable intent and transcript
available while execution remains blocked.

The current private execution evidence has one Control Plane workspace. An
enlisted Agent from another workspace can participate in a host group, but the
reader withholds execution evidence for that foreign lead: host service scope
must not substitute for the Agent's source profile, model or tool authority.
The reader compares the Agent's current home workspace under the canonical
Agent row lock. Supporting foreign lead execution requires a separately bound
source-authority contract; changing the workspace selector alone would also
change credential, funding, execution and publication scope. This guard does
not remove group history, revoke enlistments or change independent job lifecycle.

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

The private reader constructs its response inside `withCurrentLeadTurnProduct`: canonical actor, audience, profile and message locks stay held through the final asynchronous service verification and response construction. A detached evidence snapshot must never be used for disclosure after those locks are released.

## Proposed first foreign-Agent execution slice (#1178)

This is a proposal for review before shared-contract edits. The foreign-Agent
guard remains in force. Start with one enlisted source lead in one host group,
one explicit human turn and one existing source-authorized execution destination.
Use the canonical product adapters and upstream Pi-native execution; introduce
no second conversation or memory engine.

The current `workspaceId` is overloaded: it selects the service credential,
immutable profile, model, execution correlation and publication scope. Replacing
it with the Agent's source workspace would lose the host conversation boundary.
Adding a source field only to profile lookup would leave host model/tool authority
in place. The smallest complete slice must carry both bindings through the
existing path, rather than enabling either partial substitution.

| Binding           | Canonical owner and use                                                                                                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host conversation | Adea host workspace and its CP mapping, channel identity/version, original human, message identity/version, current audience and enlistment. Product reads, join-point history and publication remain host-bound.                                                      |
| Source Agent      | Adea Agent identity and current home workspace, source CP workspace mapping and CP Agent identity, exact immutable profile ID/version/revision. Profile and model resolution, runtime workspace/tool authority and existing funding authorization remain source-bound. |
| Native context    | One Pi-native context per host conversation plus qualified source Agent identity. Two groups enlisting the same Agent must not share native history, memory or session state. Execution/attempt identity stays bound to its immutable intent.                          |

Adea must derive the source mapping from the locked canonical Agent/workspace
rows, never from a browser selector or a claimed grant source. Preserve current
host actor/audience/enlistment checks and lock ordering. Source mapping/profile
changes must invalidate retained preparation rather than repin it. The trusted
evidence digest must bind both workspace mappings, the qualified Agent and
conversation/context identity as well as existing message/profile/model pins.
Continue to accept only opaque references in public commands.

CP must retain and compare both bindings across preparation, retry/restart,
dispatch, continuation and publication. The private host product read keeps its
host-scoped existing service credential; an enlistment or that credential cannot
prove source execution authority. CP must independently check existing source
principal/grants, exact source profile and source model selection, tool workspace
and recorded payer authority before execution and again before a physical send.
Explicit role references remain distinct and source-scoped; neither a missing
source profile/model nor a denied requested selection may fall back to a host
default. Missing existing source authority keeps execution blocked. This slice
creates no credentials, grants, accounts or payer authority.

Context input is limited to currently authorized post-join host history and
explicit audience-aware shared summaries/resources. Do not copy the source
Agent's private native history or pre-join host history into the group. Revoked
host audience/enlistment or source execution authority must deny future reads
and turns immediately. Retain independent job lifecycle; a late result is held
when publication is no longer authorized. Publication must bind the host
conversation and the retained source execution/attempt/session/model/actor and
exact output digest. Keep CP publication verification independent of callbacks
into Adea while Adea holds its publication transaction locks.

Review the versioned evidence/admission/runtime/publication and public SDK
compatibility surface together before implementation. Coordinate shared private
reader/publication files with their cutover owners; #1222 and external Claude
export/UI work are outside this source-authority slice.

The acceptance proof needs a real disposable source workspace tool effect with
both positive and denied cases: source profile/model preserved despite different
host defaults; host authority cannot execute source tools; same-name Agents stay
qualified; two host groups isolate native context; pre-join/private source history
is absent; changed mappings/profile pins and revoked host/source authority deny
fresh reads/dispatch; retry/restart retains both bindings; unauthorized late
publication writes nothing while independent job state survives. Synthetic ports
alone cannot qualify this slice. Remove the guard only after the complete dual
binding path and physical-source proof are reviewed.

## Disposable PostgreSQL checkpoint (2026-10-13)

On published Adea head `5c32e220dac26b0aac6cf0487fe2a8957b02e937`, a fresh
disposable PostgreSQL 18 instance bound only to loopback passed the canonical
`bun run --cwd packages/db db:verify` runner: 52 migrations applied and an
unchanged deterministic rerun. Existing databases were not modified.

With `DATABASE_URL` pointing only to that disposable instance and the
`react-server` condition, the following integration files passed:

- `packages/db/tests/integration/lead-turn-product.test.ts`: 7 passed, 0 failed,
  including foreign source propagation, distinct host-group context identity
  and enlistment revocation.
- `packages/db/tests/integration/group-channels.test.ts` and
  `packages/db/tests/integration/lead-turns.test.ts`: 73 passed, 0 failed.

Fresh focused reader/service-auth/runtime/SDK tests also passed 40 tests; the CP
product/HTTP suite passed 13 on companion published head
`bc1d84647d62babd5f8241bfcdd0b24087f815ff`. Those focused checks use synthetic
ports. Database qualification does not establish source runtime/tool effects,
live provider qualification or completed foreign-Agent execution acceptance.

### Additive canonical source reader checkpoint

`withCurrentSourceLeadTurnProduct` is a candidate in-process reader, separate
from the guarded HTTP endpoint. It resolves the exact source CP selector and
canonical intent, requires the original actor's current `runtime.invoke` in the
source workspace, and holds the actor's users-row share lock plus source
membership/mapping locks (in that order, matching canonical reorder) before entering the
existing locked host product reader. Current host actor, audience, message,
profile and enlistment remain required. Disclosure retains both workspace
mappings, the exact qualified Agent and the effective enlistment ID/revision.
Source role loss, pending deletion, host enlistment revocation and a wrong host
selector deny; asynchronous disclosure holds source revocation/mapping locks.

This reader creates no service credentials or source CP execution/model/tool/payer
authority. Its consumer must independently verify existing service authority for
both workspaces and current CP source authority. It is not wired to the HTTP
endpoint or enabled execution; the foreign-Agent guard remains unchanged.

Review repair: after the host helper's Agent/message lock waits, the source
reader rereads the original human audience window and rechecks both audience and
enlistment immediately before disclosure and after awaited final verification.
A PostgreSQL Agent-lock barrier reproduces an audience grant expiring after the
host helper's earlier time snapshot; the source reader denies disclosure without
renewing either grant. The reorder deadlock found in review is repaired in the
reader (actor users-row share lock first; see
`docs/evidence/1178-source-lock-order-qualification.md`). Full lifecycle/physical
source qualification remains outstanding.

### Candidate shared-contract consumer

`sourceLeadProductSnapshot` projects the locked canonical source product into the
actual candidate shared host/source schema, keeping the original prompt and fixed
intent-derived expiry. It uses the shared conversation+Agent context helper;
missing candidate contracts fail closed. `isSourceLeadPublicationCurrent` compares
trusted publication metadata to the same locked host/source product, exact retained
profile/model/execution/attempt/session/preparation/dispatch pins and exact UTF8
output digest. Audience, enlistment, source profile/mapping or deadline changes
deny; a read or delivery never renews the intent lifetime.

These are candidate in-process adapters, tested against the actual CP checkout's
shared schemas. They create no authority or publication effect and are not wired
to HTTP, the shared guarded reader or existing runtime/preparation/publication
routes. Source-authorized destination configuration, production combined fences,
delivery integration and disposable physical tool-effect proof remain outstanding.

The consumer test now uses an in-repository byte-for-byte contract fixture pinned
to CP `6c296fbe561b755bda0fa87f7e1a05ab451bc2f7`, with provenance hashes and a
separate frozen Zod 4.6.5 lockfile. Normal web tests run its explicit setup;
direct invocations require `bun scripts/setup-source-contract-tests.mjs` first.
No sibling checkout, schema fallback, package publication or silent skip is used.
Publication tests cover exactly-now expiry, over 30 seconds, the original intent
deadline and delayed final verification; PostgreSQL also covers grant expiry
during an awaited final service verification callback.
