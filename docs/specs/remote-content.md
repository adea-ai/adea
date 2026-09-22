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
unknown keys, unsupported envelope or payload schema versions/suites,
noncanonical base64url, malformed UUIDs/timestamps, and invalid digest shapes
are rejected. The expected `keyId` is required by `openRemoteContent`, so a
caller cannot silently decrypt with a key from another registration or version.

The plaintext limit is 1 MiB. Ciphertext is bounded to plaintext plus the
16-byte AES-GCM tag. Envelope lifetimes must be positive and at most 24 hours;
an envelope at or after `expiresAt` is rejected before decryption. Errors have
stable codes and never include plaintext, ciphertext, key material, or library
details.

## Key boundary and lifecycle

`generateRemoteCommandKeyPair` and the HPKE operations accept `CryptoKey`
objects. The caller owns the trusted native/host boundary and must keep private
key material in OS secure storage or an approved self-hosted secrets provider.
This package does not register RuntimeNodes, persist public keys, rotate or
revoke keys, retain queued envelopes, or access cloud/Neon state. Signing keys
and ContentSyncDevice synchronization keys remain separate contracts.

The checked-in fixture contains deterministic test-only input material and
known ciphertext. It is not a production key. The fixture demonstrates that a
browser-compatible TypeScript caller and a Bun caller can consume the same
language-neutral envelope bytes; standalone-host, native secure-storage,
rotation, revocation, queued-envelope grace, and #187 command integration still
require their owning lanes.

## Pinned by

- `packages/remote-content/tests/unit/remote-content.test.ts` — deterministic
  standards-library vector, round-trip encryption, AAD/ciphertext/recipient
  tampering, expiry, downgrade, suite/key mismatch, malformed fields, size
  bounds, and error redaction.
- `packages/remote-content/fixtures/remote-content-envelope-v1.json` — known
  nonproduction vector inputs and expected RFC 9180 envelope bytes.
