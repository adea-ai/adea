# Spec: runtime nodes

How Adea knows which machines belong to a workspace, and how those machines prove
it. This page is the contract to read before touching
`packages/db/src/runtime-nodes.ts`, `packages/db/src/schema/runtime-nodes.ts`,
`apps/web/src/server/runtime-node-{proof,request}.ts`, or the runtime node routes
under `apps/web/src/start/routes/api/v1/workspaces/$workspaceId/runtime-nodes/`.

**Changelog discipline:** a change to the behaviour described here lands in the
same commit as the update to this page (see `.github/CONTRIBUTING.md`).

## Scope

This page describes **identity**: registering a node, proving it is alive,
rotating its keys, and revoking it. It is the substrate the local and
self-hosted runtime work builds on. It does not describe command dispatch,
relay, or execution: nothing here can make a machine run anything, and no path
in this subsystem reads a secret from a node.

A registered node is **not a principal**. It has no session, no cookie, and no
permission of its own; every request that registers, rotates, or revokes one is
authorized as a _user_ who holds `runtime.invoke` on the workspace (owner or
admin, see `packages/types/src/index.ts`). This is what keeps a compromised
node's key from being able to grant itself anything beyond proving it exists.

## Two kinds, two key classes

`runtime_nodes.kind` is either `local_device` (the user's own machine) or
`remote_host` (a self-hosted server). The kind is fixed at registration, is
carried on every challenge, and is signed into pairing messages.

Every node holds exactly two keys, and the classes are not interchangeable:

| Role                 | Algorithm | Purpose                                            |
| -------------------- | --------- | -------------------------------------------------- |
| `signing`            | `ed25519` | Proves identity and liveness by signing challenges |
| `command_encryption` | `x25519`  | Would receive command material; never signs        |

The role/algorithm pair is enforced twice, because the cost of a confused
signing key is a node that can be impersonated:

- `assertKeyRoleMatchesAlgorithm` refuses the pair in the repository, and
- `runtime_node_keys_role_algorithm_match` refuses it in the database for any
  writer that bypasses the repository.

Keys are stored as **public material only**, with a fingerprint of
`sha256(raw-key-bytes).base64url` (`fingerprintOf`). The fingerprint is what
identifies a key across restarts: it is stable, it is safe to log and publish,
and resuming a device looks up the active signing key by it. Key material is
versioned per role (`key_version`, unique per node+role), and a key row is
either active or carries `retired_at` — a node never has two active signing
keys.

## Pairing

Pairing is a signed exchange in three steps:

1. **Open a challenge** (`POST .../runtime-nodes`). An owner or admin asks for a
   pairing challenge for a kind. The server stores a random 64-character nonce
   with the challenge's purpose (`pair`), kind, and workspace, and returns
   `{ challengeId, expiresAt, nonce }`. The kind is the challenge's audience: a
   `local_device` challenge cannot register a `remote_host`. For a `remote_host`
   the same response carries a one-time **exchange credential**, returned exactly
   once and stored only as a SHA-256 digest.
2. **Sign the challenge.** The node signs the canonical message for its purpose
   (`runtimeNodeProofMessage`):

   ```text
   adea-runtime-node-pairing:v1:<kind>:<workspaceId>:<challengeId>:<nonce>
   adea-runtime-node-rotation:v1:<runtimeNodeId>:<challengeId>:<nonce>
   adea-runtime-node-proof:v1:<runtimeNodeId>:<challengeId>:<nonce>
   ```

   Binding kind, workspace, node, challenge, and nonce is what stops a captured
   signature from being replayed against a different node, workspace, or
   purpose; the version prefix is what will let the message change shape later
   without ambiguity. The exact bytes are built in one place so both sides read
   the same source.

3. **Register** (`POST .../runtime-nodes/pair`). The route verifies the signature
   against the **presented** signing key _before_ any state changes, then spends
   the exchange credential (for a `remote_host`) and records the node, its keys,
   and a `runtime_node.paired` event in one transaction.

Verification happens first on purpose: a proof that does not verify must not
burn a one-time credential or a challenge. A refused pairing leaves the
challenge usable, which is what lets a transient client bug be retried without
re-opening a challenge.

**Resume, not duplicate.** Registering an _active signing fingerprint_ that the
workspace already knows resumes that node: the same node id and keys, refreshed
verification timestamps, and a `runtime_node.proof_accepted` event rather than a
second identity. A different signing key in the same workspace is a different
node, which is how a second laptop stays distinguishable. A revoked node refuses
to resume and must be paired deliberately as a new identity.

**Challenges are single-use and short-lived.** Consumption is atomic — an
`UPDATE ... WHERE consumed_at IS NULL` that refuses a second consumer even under
concurrency — and is bound to purpose, kind, and (where the purpose names one)
the runtime node. A pairing challenge is good for 10 minutes; rotation and
liveness challenges for 2. Expired, consumed, mismatched, and unknown
challenges are refused with distinct codes so a client can tell "retry with a
new challenge" from "you are doing the wrong thing", while a _foreign_ or
missing node always gets the same generic answer so a caller cannot probe for
another workspace's hosts.

**Self-hosted hosts never become users.** A `remote_host` must present the
one-time exchange credential it was issued; the credential is bound to the
challenge it was created for, is refused when spent or expired, and is consumed
in the same transaction as registration, so a host cannot register twice from
one grant. `local_device` registrations must _not_ carry a credential (the
parser refuses one), which keeps the two flows from being conflated.

## Rotation and revocation

**Rotation verifies the replacement before retiring the old key**
(`rotateRuntimeNodeKeys`): the new keys are inserted and marked verified, and
only then are the previous keys retired. A failed or interrupted rotation
leaves the old key working, so a node can always be recovered with the key it
still holds. The proof must be made by the key the node _presents as its new
signing key_, so a rotation that swaps in a new key while signing with the key
being retired is refused — the replacement has to prove possession of itself.

**Rotation is per role.** A rotation that presents the current signing key
proves with it and replaces only the command-encryption key; that key's version
increments and the node's identity is unchanged. That path exists because an
X25519 key can be replaced without re-establishing who the node is, and it is
why the signing-key version is the field to compare when asking "did the
identity key change?".

**Revocation is a state change, not a delete** (`revokeRuntimeNode`): the node
keeps its identity, keys, and history, gains `revoked_at` plus a reason, and
stops being eligible. `requireEligibleRuntimeNode` is the gate every future
command, relay, or scheduling path must call: it requires an existing,
non-revoked node with a verified active signing key and returns that key's
fingerprint for audit. A revoked node is also refused a new challenge, so a
stale client cannot keep proving liveness for something the workspace has
disowned.

**Node identity is independent of sessions.** Signing out — a session expiring
or being revoked — leaves every node paired, verified, and eligible, so signing
back in finds the machines where they were; only an explicit revocation changes
that. Claiming a guest session into an existing account hands the workspace to
the account's user, and the nodes travel with the workspace: same ids, same
keys, same eligibility. The principal that paired a node stays on the row
(`owner_user_id`) as provenance and is not the authorization path — access to a
node is decided by workspace membership plus `runtime.invoke`.

## The read model

`readRuntimeNode` and `listRuntimeNodesForUser` return public material only:
display name, kind, platform, software version, pairing state, timestamps, and
the key list, each key carrying its role, algorithm, public key, fingerprint,
version, and verified/retired timestamps. No private key, credential digest, or
node endpoint is ever part of the view — there is nothing for a client to leak.

`health` is derived on read from the last accepted proof, never stored:
`unknown` when no proof has ever been recorded, `healthy` within
`RUNTIME_NODE_STALE_AFTER_MS` (5 minutes), `stale` beyond it. Pairing and
rotation count as proofs — the node demonstrated possession of its key — so a
freshly paired node reads healthy rather than unknown. Nothing sweeps nodes in
the background, so an expired proof cannot silently change authorization.

## Durable events

Every state change is recorded through the one publication path
(`appendWorkspaceEvent`), so the workspace's event stream and the audit trail
see it in the same transaction as the change:

| Event                         | Payload beyond `runtimeNodeId`                                |
| ----------------------------- | ------------------------------------------------------------- |
| `runtime_node.paired`         | `actorUserId`, `challengeId`, `kind`, `signingKeyFingerprint` |
| `runtime_node.key_rotated`    | `actorUserId`, `keyFingerprints`                              |
| `runtime_node.proof_accepted` | `actorUserId`, `challengeId`                                  |
| `runtime_node.revoked`        | `actorUserId`, `reason`                                       |

Payloads carry fingerprints and ids, never key material, and stay inside the
fail-closed redaction rules of `docs/specs/workspace-events.md`.
`aggregate_type` is `runtime_node` for all four, which is what lets a client
refresh exactly one node's view from the stream. The realtime client's family
map has no `runtime_node` entry yet, so these events currently refresh the
workspace scope (`['workspaces', workspaceId]`) — correct but coarse. Adding the
family means adding a runtime-node query-key group to `packages/data` first, so
the mapping and the keys land together rather than pointing at nothing.

## Failure semantics

`RuntimeNodeError.code` is the stable part of a failure; the message is not.
Routes map them as: `not_found` → 404, `unauthorized` → 403, everything else →
409, and a refusal that must not disclose whether a node exists uses the generic
`workspace_unavailable` response. A proof that does not verify is a `400`
`invalid_request`, never a 200 with a quiet no-op.

Requests that claim to come from the desktop shell (`x-adea-client: desktop`)
are additionally held to the shell's own origins, and answers to them are
`private, no-store` and carry CORS only for a trusted origin — the same guard
the rest of the workspace API uses (`docs/specs/desktop-auth.md`).

## Retention

`pruneRuntimeNodeCredentials` removes expired challenges and expired
registration credentials in bounded batches. Credentials are collected before
challenges because deleting a challenge cascades to the credential that
references it. Nodes, keys, and events are never pruned: an identity that was
revoked years ago is still the answer to "which machine was that?".

Like `pruneWorkspaceEventsBefore`, this is a retention function an operator or
scheduled job calls; nothing runs it automatically, so the local database and CI
never depend on a timer and a missing scheduler cannot silently shorten a
challenge's life.

## What pins this

- `packages/db/tests/integration/runtime-nodes.test.ts` — pairing and resume,
  the second device, exchange-credential single use and binding, challenge
  replay/expiry/purpose/node binding, the role↔algorithm rule at both layers,
  rotation ordering, revocation semantics, sign-out and account-switch
  boundaries, cross-workspace invisibility, the read model, the durable log,
  retention, and cross-node proof binding.
- `apps/web/test/runtime-node-proof.test.ts` — real Ed25519 signatures: exact
  message shape, tampering, replay across workspace/node/purpose/kind, an
  impostor key, and malformed input treated as failure rather than an exception.
- `apps/web/start/browser/runtime-nodes.e2e.ts` — the whole flow against an
  isolated host and PostgreSQL, including the desktop-origin guard.
- `scripts/event-stream-authorization-boundary.test.ts` — the stream authorizes
  with `workspace.events.read` at both the first byte and the mid-stream
  recheck, and every role that can read a workspace holds it.
