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
duplicate claim fails as `replayed`. `openRemoteContent` only accepts the
runtime-branded guard returned by `createRemoteContentReplayGuard`; a raw
structural `{ claim }` callback fails closed as `replay_unavailable`. The
adapter rechecks expiry after the awaited ledger result as well, so a ledger
that completes after expiry cannot release plaintext. The host ledger should
also enforce expiry atomically in its durable insert/compare-and-set. The
tuple above is the
envelope-level replay identity. The host's existing command idempotency index
must also reject a reused `(workspaceId, runtimeNodeId, requestId)` paired with
a fresh `enc` or `keyId`; this adapter does not add a second durable index.
The ledger callback must provide the durable atomic insert/compare-and-set
operation; the package cannot prove atomicity for an adapter backed by an
external database.

## Request-bound return results

`createRemoteResultReceiver` creates a fresh client X25519 key pair for one
workspace/node/request and a positive validity window of at most 24 hours.
WebCrypto generates its private key as nonextractable. A module-private WeakMap
holds that key; the frozen receiver exposes only a public descriptor. Neither
JSON serialization nor a structurally copied receiver exports or recovers the
private capability. The descriptor contains exactly `version`, a fresh
`return_<UUID>` key ID, canonical 32-byte base64url `publicKey`, `workspaceId`,
`runtimeNodeId`, `requestId`, `issuedAt` and `expiresAt`.

The client places the public descriptor inside its authenticated encrypted
command body. The host's `sealRemoteResult` validates its exact bounded shape,
canonical fields and expiry, and matches all three scope identities against the
independently authorized command. It seals with the existing standards-library
suite and envelope v1, using authenticated `execution.result` payload type and
the descriptor's return key ID, scope and validity window. It introduces no new
cryptographic primitive, envelope wire version or command-key authority.

`openRemoteResult` checks the original receiver, scope, return key ID, payload
direction and window before the generic authenticated decrypt/replay operation.
The same branded atomic replay guard is required. Only one in-flight open and
one successful plaintext release are permitted per receiver. A failed
authentication does not consume the receiver. After success, the private key
reference is dropped. `closeRemoteResultReceiver` drops it on cancellation,
account/workspace changes or client teardown, including during an awaited
replay claim; a cancelled handoff clears decrypted bytes and fails closed as
`return_key_unavailable` instead of releasing them.

HPKE **base mode does not authenticate the sender**. Return-key possession is
not host authorization. The caller must validate the host's authenticated
transport or signed receipt before calling the result opener. Similarly, the
host must authorize the command before trusting its return descriptor. The
module establishes confidentiality and request binding; durable relay/inbox
storage, authenticated node receipt handling, reconnect/restart key recovery,
queued key rotation/revocation and product lifecycle integration remain their
owning lanes. These transient result keys grant no ContentSyncDevice or
durable-history decryption authority.

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

## Initial cloud queue producer

The initial cloud queue producer (`packages/db/src/task-submissions.ts`) parses
the exact v1 envelope, requires `command.input`, and binds workspace, selected
node, request UUID and active verified encryption-key UUID. Admission rejects
expired, oversized, future-issued or excessive-lifetime envelopes and stores
the normalized ciphertext only in `command_outbox`, with immutable Task/profile
and public scope metadata. The separate `task_submissions` row and durable
`task.submission_queued` event carry coordination metadata without ciphertext.
An identical retry reuses the original intent; another key or changed envelope
cannot silently create a second logical submission for that Task. Expired
intent reads report `expired` and retain the identity rather than resubmitting.
After cleanup, the durable purge marker also forces the `expired` read state,
even if the application clock is behind the database; it never reports purged
work as pending delivery.
The outbox foreign key refuses deletion while its intent survives. Bounded
operator cleanup removes the expired `payload.envelope` without erasing that
identity or the retained payload hash. Initial admission
checks conversation and objective-reference workspace ownership and refuses a
Task with an existing execution reference. Duplicate reads retain their original
snapshot rather than adopting newer Task/profile/conversation metadata.
This producer neither authenticates ciphertext nor accepts execution. Authenticated
host receipt handling, local inbox/decrypt, fresh host authorization, operational
expiry cleanup, host key grace, SDK validation/acceptance and reconciliation remain required
before the delivery path can run work.

## Cloud relay ciphertext retention

`packages/db/src/task-submission-retention.ts` supplies a read-only bounded
preview and an atomic purge for one explicit workspace, with a limit of 1–1,000
submissions. The database statement clock decides expiry; the caller cannot
supply an earlier cutoff. A partial workspace/expiry/identity index contains
only submissions whose `ciphertextPurgedAt` is null. A database constraint
refuses a purge marker earlier than the submission's expiry.

Purge locks each selected submission and outbox row with `SKIP LOCKED`, removes
only the outbox's `envelope`, and writes the marker in the same transaction.
Five-second statement and one-second lock deadlines bound each operation.
Intent identity, payload hash, selected node/profile, outbox status/attempts,
Task lifecycle, execution attempts, keys and canonical history are preserved.
Already-absent envelopes are marked once; the count reports processed intents,
not byte reclamation. Rollback restores both envelope and marker. A skipped
locked row remains eligible, so a zero purge count does not establish an empty
backlog. Preview can observe locked candidates and must be repeated as needed.

The supported [`relay:purge` operator entry](../guides/relay-ciphertext-retention.md)
defaults to dry-run and requires exact database target, workspace and limit.
It uses the private direct application-role connection, never migration
credentials or client configuration, and emits counts or fixed error codes.
Nothing schedules it automatically. Scheduling, production rollout and host
inbox/key retention are separate operational acceptance. Removing a current
JSONB envelope does not establish secure erasure from WAL, backups or replicas;
those stores retain their own policy. Relay cleanup never purges Message or
ContentReplica history.

## Pinned by

Authenticated node pull projects fixed public metadata and the original parsed
envelope only after fresh node, signing-key, original submitter, Task and Agent
checks. A rotated encryption key serves only an admitted envelope issued before
retirement, within its own expiry and the 24-hour grace. Node revocation and
retired signing keys block pulls; ciphertext is never rebound or re-encrypted.
Host retention of the old private key, durable inbox, local authorization and
SDK acceptance remain separate requirements.

- `packages/db/tests/integration/task-submissions.test.ts` — actual database
  expiry, bounded scope, preserved intent/history/status, concurrent claims,
  locked rows, rollback, schema constraint and supported operator dry-run/apply.
- `packages/db/tests/integration/runtime-node-delivery.test.ts` — no redelivery
  after expiry cleanup, alongside current node authorization and key grace.
- `scripts/relay-retention-config.test.ts` — explicit target, private app-role
  connection, bounded arguments and sanitized refusal.

- `packages/remote-content/tests/unit/remote-content.test.ts` — deterministic
  standards-library vector, round-trip encryption, AAD/ciphertext/recipient
  tampering, key-ID retagging, expiry, downgrade, suite/key mismatch, malformed
  fields, encoded-size preflight, scope-bound replay-guard ordering and
  expiry, and error redaction.
- `packages/remote-content/fixtures/remote-content-envelope-v1.json` — known
  nonproduction vector inputs and expected RFC 9180 envelope bytes.
- `packages/remote-content/tests/unit/remote-result.test.ts` — distinct client
  return recipients, no private-key serialization, scope/direction/window
  binding, strict public descriptors, wrong command keys, concurrent replay,
  cancellation during an atomic claim, bounded content and sanitized errors.
- `apps/web/e2e/remote-result-crypto.spec.ts` — production module bundled for
  headless Chromium, client-held return key, Node and Bun host sealing and
  browser decryption, no private-key transfer and no second plaintext release.
  The main E2E lane includes this fixture; it validates crypto interoperability,
  not the unfinished relay or authenticated host-receipt integration.
- `packages/remote-content/tests/unit/node-entry.test.ts` — consumes the built
  Node ESM entry without a TypeScript loader, preserving command exports and
  completing a request-bound result round trip. The package test command builds
  the entry before running Bun's native suite.
