# Spec: cloud ContentReplica persistence

The cloud side of private-content synchronization. This bounded contract covers
the durable encrypted replica row and its idempotent replay semantics. Device
provisioning, ContentKeyEpoch lifecycle, HPKE envelopes, and endpoint decryption
remain separate work.

## Boundary

`ContentRef` remains the logical user-visible identity. A `ContentReplica` is a
physical encrypted copy of one `ContentRef` revision. The cloud row stores only
workspace-scoped metadata, an opaque base64url nonce, and base64url ciphertext
(including its authentication tag). It never stores plaintext, a content key,
or caller-supplied associated data. The authorized decrypting endpoint derives
associated data from the immutable workspace, ContentRef, replica, revision,
schema, and key-epoch identity.

Ciphertext decodes to at least a 16-byte authentication tag and at most 2 MiB.
The HTTP request body is bounded to the encoded ciphertext plus a fixed metadata
allowance before JSON parsing; the database boundary repeats the decoded-size
and canonical-base64url checks.

Replica kinds are `local_authority`, `self_hosted_authority`, and
`agent_hq_e2ee_sync`. The E2E kind requires a `keyEpochId`; authority replicas
must not carry one. A replica's digest is the canonical plaintext digest and is
always retained as metadata for integrity and conflict detection.

## Replay contract

The physical identity is `(contentRefId, revision, replicaKind, keyEpochId)`.
Retries with the same identity and identical opaque payload return the existing
row as `duplicate`; they do not create another row or event. A retry for an
older revision returns the newest row for that physical identity as `stale`
without changing durable state. A digest mismatch for the same logical
ContentRef revision, or a different ciphertext/nonce for an existing physical
identity, fails closed with a conflict. A newer revision is inserted once.

The domain operation is membership checked and transactional. Only a ContentRef
whose synchronization policy is `agent_hq_e2ee_sync` can receive a cloud
replica; local-only refs stay explicitly unavailable remotely. Replica writes do
not append a WorkspaceEvent in this slice: reconnect/history consumers read
authoritative ContentRef and ContentReplica state, while the event log remains
free of ciphertext and duplicate replay notifications.

Replica listing applies the same existing, synchronization-enabled ContentRef
check as writes. A nonexistent, cross-workspace, or local-only ContentRef is an
explicit unavailable response and never an empty successful list.

## Persistence checks

The schema enforces positive revisions/schema versions, SHA-256 digest shape,
12-byte nonce encoding, canonical base64url ciphertext, its decoded-size/tag
floor, kind/key-epoch consistency, deletion consistency, workspace and
ContentRef foreign keys, and partial unique indexes for epoch and no-epoch
physical identities. Integration fixtures use an encoded ciphertext canary and
assert that the persisted Neon-shaped rows contain no plaintext or key material.

The separate `RemoteContentEnvelope` execution transport and HPKE key-envelope
implementation are intentionally outside this contract.
