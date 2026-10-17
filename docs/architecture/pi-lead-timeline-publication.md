# Lead timeline SDK response boundary

The configured lead product invokes the installed SDK, whose methods return complete success envelopes. Dispatch, status, progress and cancel runtime transports consume only the strictly SDK-validated `data` with `schemaVersion: pi-lead-dispatch/v1`. Preparation and lookup retain their existing full-envelope decoders. Funding and current publication retain their separate pinned responses.

Without this projection, a valid dispatch response fails runtime binding validation and leaves the canonical intent `dispatch_pending`; a completed status never reaches timeline publication. The production composition now performs this projection without adding a raw HTTP fallback or accepting caller execution authority.

The completion path retains original actor, execution, attempt, session, selection and preparation pins. It checks the exact UTF-8 result digest through current CP publication authority under Adea's canonical publication locks, then commits one message and receipt. Denied authority or changed pins withhold output; status retry does not dispatch again. CP publication authority must remain lock-safe and never call Adea's private product reader while Adea holds these locks.

Focused tests exercise the real Adea composition and runtime using an explicitly mocked CP transport and an in-memory store. The separate restricted PostgreSQL fixture exercises the real product/repository timeline append using that same mocked CP transport. Neither proves the released SDK, CP production authority, model inference, provider credentials, device authority or deployment. Actual #996 public packages and independently authorized operator configuration remain required; missing configuration or installed SDK support continues to fail closed.

The frozen #1202 disclosure/role fixes and its prior failures remain separate evidence. No migration, credential, grant, screenshot or UI baseline change is part of this slice.

Trusted terminal publication uses a server-only message write boundary that preserves the exact authorized UTF-8 text in both the canonical body and creation identity. Ordinary user message creation retains its existing trim normalization. Leading indentation and trailing whitespace are part of the accepted output; changed text on replay is rejected.

## Read-only child observations (#1173)

`GET /api/v1/workspaces/:workspaceId/lead-turns/:intentId/children` reads one
retained child page through the installed SDK 1.19.0
`getPiDurableLeadChildren` operation. The browser supplies only the canonical
intent and optional `limit` (1–256), or the paired `afterAcceptedAt` and
`afterDelegationId` cursor. The server resolves the existing current original-actor,
audience and workspace read authority and the retained dispatch itself. It uses
only the existing `execution:read` service scope, validates the published SDK
schema and exact intent/execution/attempt/session/dispatch pins, and rechecks
canonical authority and lineage after the CP read. No child observation is
persisted as a lead state or timeline message.

The response carries the canonical `leadTurn` separately from `childObservations`.
An available observation includes `children`, `totalChildren`, `complete`, and
`next` when another page exists. Pages are individual snapshots; callers must
follow the cursor and reconcile changing totals before claiming a settled set.
Only an available, complete zero-count page proves an empty set. No dispatch,
missing SDK/adapter support, CP refusal, or malformed response reports an empty
or complete set: it returns an unavailable reason without child data. A revoked
caller receives no disclosure. The route retains private/no-store responses.

Child state, pending stop, input wait and retained outcome/publication are
observations. A child's published outcome does not prove publication to Adea's
conversation; a result reference grants no artifact access. This endpoint cannot
start, advance, stop, cancel, approve or publish child work, and adds no canvas
binding or action controls. A completed lead may have a child still running or
waiting independently.

The CP #1160 contract is released, but production composition still requires the
CP-owned `childDelegations` reader. Until that reader is wired, live calls return
`PI_LEAD_NOT_CONFIGURED`, surfaced here as `RUNTIME_UNAVAILABLE`. Tests exercise
the released SDK with a synthetic HTTP transport and the real Adea consumer with
in-memory canonical stores. They do not qualify a live configured CP host, child
execution, provider, credentials, or the full mounted lead-to-child journey.
