# Shared types

Small domain contracts shared across Adea packages, including workspace scenes,
agents, tasks, and messages.

`@adea-ai/types/runtime-node-delivery` exports the strict outbound pull proof,
canonical message and WebCrypto verifier. It grants no user authority and
persists no private key. Host transport consumers use this focused entry.

Dev Runtime's complete contract is exported from `@adea-ai/types/dev-runtime`.
Client code that needs only a part of that contract should use the focused
subpaths: `dev-runtime-operation-metadata` for tree-shakeable operation
capabilities and resource bindings, `dev-runtime-metadata` for the compatibility
aggregate used by dynamic clients, `dev-runtime-wire` for canonical event and CBOR codecs,
`dev-runtime-video` for bounded browser-frame relay codecs,
`dev-runtime-control` for strict heartbeat and resync frame decoders, and
`dev-runtime-registry-dto` for strict registry record decoders. The full
`dev-runtime` entry re-exports the video helpers for compatibility; browser
clients should import them from the focused video subpath so a lazy relay view
does not load the operation registry. The full contract delegates registry
decoders to the same implementation, so server reply validation and lazy
client views keep one validation rule set.

`dev-runtime-wire` also exports `RuntimeUsageObservedPayload` and
`decodeRuntimeUsageObservedPayload(value, expectedGeneration)` for strict
`usage.observed` production. `RuntimeEvent<'usage.observed'>` types that payload;
`decodeRuntimeEvent` enforces the same schema at the wire boundary. Each snapshot
names one provider/model and the enclosing session generation, with independently
nullable current-context used/total figures and optional reported token breakdown
and exact-decimal cost. Unknown figures stay unknown; no context, price, or usage
is estimated. See the [normative usage contract](../../docs/specs/dev-runtime.md#context-and-token-usage-observations-1391)
for counter semantics, bounds, compatibility, and snapshot replacement rules.

The complete Dev Runtime entry exports the `FollowUpQueueRequest`,
`FollowUpQueueSnapshot`, and `FollowUpQueueEventPayload` types. Host and queue
consumers that need the full validators should import them from the focused
`dev-runtime-follow-ups` entry; it also exports `decodeFollowUpQueueReply`.
The focused wire entry checks `queue.updated` authority, identity, and prompt
redaction, while the host event log applies the complete payload validator
before persistence and replay. These host snapshots contain queue
identity/order/outcomes without prompt text. See the
[queue contract](../../docs/specs/dev-runtime.md#authorized-queued-follow-ups-1393)
for bounded storage, generation/version fences, explicit delivery, replay,
and interaction with Stop/Steer. No consumer control or unsupported transport
capability is supplied by these types.

`dev-runtime-activity` exports bounded test-run, command-output, failure/stack,
changed-files, plan and task payload schemas. The wire entry's
`decodeRuntimeActivityEvent` additionally requires authenticated producer
ownership; generic replay retains opaque rows without inventing counts or
statuses. See the Dev Runtime spec's structured activity producer contract.

The focused `dev-runtime-browser` entry re-exports the existing canonical CBOR
decoder and lean envelope decoder without evaluating complete event admission.
Full history and host admission continue to use `decodeRuntimeEvent` through
`dev-runtime-wire`; no history validation or provenance check is replaced.
