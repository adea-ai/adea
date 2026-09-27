# Shared types

Small domain contracts shared across Adea packages, including workspace scenes,
agents, tasks, and messages.

Dev Runtime's complete contract is exported from `@adea-ai/types/dev-runtime`.
Client code that needs only a part of that contract should use the focused
subpaths: `dev-runtime-metadata` for operation capabilities and resource
bindings, `dev-runtime-wire` for canonical event and CBOR codecs, and
`dev-runtime-registry-dto` for strict registry record decoders. The full
contract delegates those registry decoders to the same implementation, so
server reply validation and lazy client views keep one validation rule set.
