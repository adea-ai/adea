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

Ordinary `constructor`/`prototype` provider keys are safely stripped; only the
prototype-mutating `__proto__` key is refused during structural preflight. A
failing regression pinned that distinction before the correction.

## Validation after main integration

The candidate integrates main `25264860b403f5f400ab9b4c933f06a15524cba3`
without changing dependencies, schema or UI behavior relative to that base.

- Focused web regression: `bun test --conditions=browser test/control-plane-events.test.ts`
  from `apps/web`: 11 passed, 53 assertions.
- `bun run test:unit`: 30 successful Turbo tasks; web 320 passed with 1,403
  assertions; root coverage suite 302 passed with 7,134 assertions.
- `bun run typecheck`: 31 successful Turbo tasks.
- `bun run lint`: 17 successful Turbo tasks and root Oxlint with no findings.
- `bun run build`: 15 successful Turbo tasks, reused from the tested dependency
  builds; shared UI Tailwind source validation passed.
- `bun run format:check`: all 1,805 matched files passed before this evidence
  update; the final changed documents receive a separate formatting check.

No database integration, delivery endpoint, live host interoperability, browser
or packaged-runtime acceptance is claimed for this pure decoder. Those checks
remain required when its authenticated caller and durable effects are added.

## Current validation preparation

The candidate also integrates canonical main
`45dcf8cc29d7cb9bba4624a470f31a9c731b608d`, including #1165's qualified CI
capacity and fixture repair. Local lint passed all 17 tasks without findings,
typecheck passed 31 tasks, and formatting passed 1,812 files.

The full web suite run alongside lint/typecheck failed an existing summary-poll
fixture: its third changed-count read overtook the assertion intended for its
second read. The original isolated polling suite passed 4 tests / 18 assertions;
the full standalone web command then passed 320 tests / 1,403 assertions.
No polling source, assertion, interval or deadline changed. The initial aggregate
remains a failed receipt; fresh hosted default-concurrency validation is required.

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
