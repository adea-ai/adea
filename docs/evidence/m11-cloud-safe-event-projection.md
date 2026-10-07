# M11 Control Plane event privacy projection

This increment supplies #39's decoder/projection prerequisite, not its durable
inbox or delivery endpoint. Adea's existing generic `event_inbox` table has no
qualified Control Plane consumer; storing the public execution envelope's raw
`data` would copy unrestricted runtime/provider JSON into cloud persistence.

The server boundary imports `AgentHqExecutionEventEnvelopeSchema`, the canonical
JSON serializer, usage schema and Artifact metadata fields from the exact
published `@adea-ai/contracts` 1.14.0 dependency. It adds no package or lockfile
change and requires no Control Plane checkout or live service for its tests.

## Implemented boundary

The [normative projection contract](../specs/workspace-events.md#control-plane-execution-event-privacy-boundary)
bounds encoded bytes, recursive work, source data and the final projection.
It validates the public envelope, supported type/version, canonical source hash
and all five independently supplied correlation identities before selecting
metadata. Unknown input content and free-form diagnostics are removed; malformed
recognized metadata and contradictory lifecycle facts are refused with fixed
error codes. Fields are explicitly copied and the isolated result is deeply
frozen. The server module is included in the browser bundle denylist.

Projected state/progress, usage counts/cost and opaque Artifact ID/version/
digest/size metadata are observations. They grant no execution acceptance,
Artifact access or canonical Message authority. No selected transport/location
is inferred from the envelope, which contains neither host nor location identity.

## Local regression evidence

A public-schema passthrough first failed the privacy and refusal tests: the
schema accepts the private prompt/response/provider/context/native-path canaries
inside unrestricted `data`. This was a deliberate failing candidate, not proof
that a previously deployed Adea inbox leaked those fields. The explicit
projection then passed the focused suite.

A second failing test exposed acceptance of an `execution.accepted` event that
claimed completed state. Matching all state-bearing execution/attempt names
against any provided state made that regression pass without applying a Task
transition.

## Remaining acceptance

The caller's expected scope must come from authenticated delivery and retained
accepted execution metadata, never the incoming envelope itself. Selected
RuntimeNode/location correlation is still a separate admission requirement.
The supported host acceptance/relay adapter must preserve the Control Plane's
normal authority and supply those bindings; this decoder cannot replace it.

Durable workspace/execution-scoped inbox storage, idempotent transactional Task
and WorkspaceEvent application, ordering/gaps/terminal races, canonical
Conversation Service projections, authorized Artifact/usage effects and replay
tooling still need implementation and their fixture/deployment acceptance. No
cloud row, event, Message, Artifact or usage attribution is written here. No
issue is closed or criterion marked verified; all 149 original M11/certification
criteria and the owner's #193 scope disposition remain intact.
