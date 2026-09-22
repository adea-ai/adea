# Spec: remote content envelopes

The versioned, transient encryption envelope for sensitive remote execution
command and result payloads. This page is the contract for
`packages/remote-content/**` and is intentionally separate from durable
`ContentReplica` synchronization and local private-content storage.

**Changelog discipline:** a change to the behaviour described here lands in the
same commit as the update to this page (see `.github/CONTRIBUTING.md`).

## Cryptographic profile

Envelope v1 uses the maintained `@hpke/core` RFC 9180 implementation with one
fixed base-mode suite:

```text
DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM
```

The package does not implement a KEM, KDF, AEAD, key derivation, or wire
primitive. Its constant HPKE `info` label is
`adea-remote-content-envelope:v1`; application metadata is authenticated as
AAD by the library's seal/open operations.

## Envelope contract

The JSON shape is:

```json
{
  "version": 1,
  "suite": "DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM",
  "keyId": "node-key-v1",
  "enc": "base64url X25519 encapsulated key",
  "ciphertext": "base64url HPKE ciphertext",
  "aad": {
    "version": 1,
    "keyId": "node-key-v1",
    "workspaceId": "canonical UUID",
    "runtimeNodeId": "canonical UUID",
    "requestId": "canonical UUID",
    "payloadType": "command.input",
    "schemaVersion": 1,
    "issuedAt": "2026-09-22T12:00:00.000Z",
    "expiresAt": "2026-09-22T12:10:00.000Z",
    "contentDigest": "optional lowercase SHA-256 hex"
  }
}
```

AAD keys are ordered and serialized by the package before being passed to HPKE;
the key ID is also included in the HPKE `info` bytes. Unknown keys, unsupported
envelope or payload schema versions/suites, noncanonical base64url, malformed
UUIDs/timestamps, and invalid digest shapes are rejected. A retagged outer key
ID fails AAD validation or HPKE authentication even if a caller supplies the
retagged ID with the original private key.

The plaintext limit is 1 MiB. Ciphertext is bounded to plaintext plus the
16-byte AES-GCM tag. Envelope lifetimes must be positive and at most 24 hours;
an envelope at or after `expiresAt` is rejected before decryption. Encoded
`enc` and `ciphertext` fields are capped before base64 decoding, so oversized
attacker input cannot force an unbounded `atob` allocation. Errors have stable
codes and never include plaintext, ciphertext, key material, or library details.

`openRemoteContent` requires a caller-supplied replay guard. The guard must
atomically claim `(workspaceId, runtimeNodeId, requestId, keyId, enc)` in the
host's durable CommandInbox or equivalent ledger after successful
authentication and before dispatch. The claim includes `expiresAt`; the host
adapter refuses a claim outside its bound workspace/runtime-node scope and
rechecks expiry immediately before calling the ledger using a clock evaluated
for every claim. A missing guard fails closed as `replay_unavailable`; a
duplicate claim fails as `replayed`. Use `createRemoteContentReplayGuard` to
bind a host ledger to one authenticated scope. The tuple above is the
envelope-level replay identity. The host's existing command idempotency index
must also reject a reused `(workspaceId, runtimeNodeId, requestId)` paired with
a fresh `enc` or `keyId`; this adapter does not add a second durable index.
The ledger callback must provide the durable atomic insert/compare-and-set
operation; the package cannot prove atomicity for an adapter backed by an
external database.

## Key boundary and lifecycle

`generateRemoteCommandKeyPair` and the HPKE operations accept `CryptoKey`
objects. The caller owns the trusted native/host boundary and must keep private
key material in OS secure storage or an approved self-hosted secrets provider.
This package does not register RuntimeNodes, persist public keys, rotate or
revoke keys, retain queued envelopes, or access cloud/Neon state. Signing keys
and ContentSyncDevice synchronization keys remain separate contracts. The
replay ledger adapter remains the host/dispatch integration responsibility.
This package does not choose a database schema or claim retention policy; a
host implementation must retain claims through their envelope expiry and may
garbage-collect expired records transactionally.

The checked-in fixture contains deterministic test-only input material and
known ciphertext. It is not a production key. The fixture demonstrates that a
browser-compatible TypeScript caller and a Bun caller can consume the same
language-neutral envelope bytes; standalone-host, native secure-storage,
rotation, revocation, queued-envelope grace, and #187 command integration still
require their owning lanes.

## Pinned by

- `packages/remote-content/tests/unit/remote-content.test.ts` — deterministic
  standards-library vector, round-trip encryption, AAD/ciphertext/recipient
  tampering, key-ID retagging, expiry, downgrade, suite/key mismatch, malformed
  fields, encoded-size preflight, scope-bound replay-guard ordering and
  expiry, and error redaction.
- `packages/remote-content/fixtures/remote-content-envelope-v1.json` — known
  nonproduction vector inputs and expected RFC 9180 envelope bytes.
