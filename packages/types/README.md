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
