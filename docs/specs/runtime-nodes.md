# Spec: runtime nodes

How Adea knows which machines belong to a workspace, and how those machines prove
it. This page is the contract to read before touching
`packages/db/src/runtime-nodes.ts`, `packages/db/src/schema/runtime-nodes.ts`,
`apps/web/src/server/runtime-node-{proof,request}.ts`, or the runtime node routes
under `apps/web/src/start/routes/api/v1/workspaces/$workspaceId/runtime-nodes/`.

**Changelog discipline:** a change to the behaviour described here lands in the
same commit as the update to this page (see `.github/CONTRIBUTING.md`).

## Scope

This page describes **identity** and authenticated outbound delivery: registering
a node, proving it is alive, rotating its keys, revoking it, and pulling its
encrypted commands. It is the substrate the local and self-hosted runtime work
builds on. Execution acceptance belongs to the host: this subsystem does not
decrypt content or make a machine run anything.

A registered node has no user session or cookie. Its signing key authenticates
only its own delivery and liveness; every request that registers, rotates, or revokes one is
authorized as a _user_ who holds `runtime.invoke` on the workspace (owner or
admin, see `packages/types/src/index.ts`). This is what keeps a compromised
node's key from granting itself user, administration, execution or history authority.

## Two kinds, two key classes

`runtime_nodes.kind` is either `local_device` (the user's own machine) or
`remote_host` (a self-hosted server). The kind is fixed at registration, is
carried on every challenge, and is signed into pairing messages.

Every node holds exactly two keys, and the classes are not interchangeable:

| Role                 | Algorithm | Purpose                                            |
| -------------------- | --------- | -------------------------------------------------- |
| `signing`            | `ed25519` | Proves identity and liveness; signs outbound pulls |
| `command_encryption` | `x25519`  | Receives encrypted command material; never signs   |

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

Every node also has an immutable public Control Plane reference,
`controlPlaneRuntimeNodeRefId` (`rnr_` plus 26 Crockford characters). Adea mints
it once at registration independently of the UUID; resume, key rotation and
revocation retain it. Discovery consumers join on this reference within the
authorized workspace, never on a display name, transport, key, or array position.
Possessing the reference grants no authority and does not register the node with
the Control Plane; the host integration must present the same reference through
its authorized Control Plane boundary.

Migration `0034_control-plane-runtime-node-refs` expands the identifier generator
and adds a unique, grammar-checked column with a volatile default. Existing nodes
receive distinct references, and older application insert paths continue working.
Apply the schema expansion before deploying a consumer that selects the column.
The field is public identity metadata; it is returned in the existing node read
model alongside the Adea UUID. Control Plane host health, RuntimeConnection
health, and Adea's proof-derived node health remain separate observations.

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

The list read is deliberately unbounded: a workspace's nodes are the machines
its members pair, which is a handful. It resolves each node with two queries per
node, which is the right shape at that scale — if a consumer ever appears with
thousands of nodes, paginate or batch it then rather than carrying a silent cap.

## Control Plane connection discovery (M11 #37)

`GET .../runtime-nodes/:runtimeNodeId/connections` uses the same workspace
`runtime.invoke` permission and desktop-origin guard as the node identity API.
It resolves the registered UUID in that workspace first, then calls the pinned
public SDK's `runtime-connection.list` with exactly its `rnr_` reference and a
fresh workspace-scoped service credential containing only `runtime:read`.
The bounded, nonredirecting SDK hop and request/trace validation are shared with
the administration proxy. The only accepted query parameter is a bounded cursor;
the page limit is 100. Responses are `private, no-store`.

The projection preserves Adea registration/pairing/proof-derived health separately
from the reported Control Plane node status/health and individual connection
status/health/availability. It carries adapter/driver/harness versions, capability
support, compatibility limitations, grant requirements, entitlement state and
eligibility reason/remediation codes. It is metadata only: public keys, node
endpoints, native paths, process handles, credentials, free-form upstream labels
and native session state are excluded. The nested node's reported location must
match the registered kind. Missing/foreign node references, changed location,
duplicate connection identities and managed-cloud entries fail closed.

Every read reclassifies stale, expired or future inventory observations using the
five-minute admission window. The SDK's discovery schema does not report a
RuntimeTransport: the DTO says `transport.state: 'unreported'`. It must not infer
`direct_local` or `remote_gateway` from location or change connection identity.
Actual execution resolution owns the selected transport. Discovery remains a
read model, never an execution or authorization proof; submission must freshly
admit the registered node and respect the Control Plane's policy/capability gates.

An unconfigured signer, inaccessible service, rejected or invalid discovery reply
returns registered node metadata with `discovery.state: 'unavailable'` and no
connections. This differs from `available` with an empty inventory. It never
changes execution location, node registration, canonical conversation metadata,
ContentSyncDevice authorization or history availability. Missing/foreign Adea
nodes retain the generic workspace refusal. Consumers use the typed
`listRuntimeNodeConnections` API client; native Dev Runtime discovery retains its
existing host authority and cannot be replaced by this cloud projection.

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

## Task queue admission

Task queue admission (`packages/db/src/task-submissions.ts`) holds a shared
node lock and verified active signing/encryption-key locks through its commit.
Rotation, revocation and liveness mutation lock the node first, keeping lock
order consistent with admission. Public key read models expose each key row's
UUID as `keyId`; command envelopes address that exact verified encryption key.
Queue admission records intent only. Delivery must recheck revocation, retired
keys, task/profile authorization and expiry before releasing a command.
`packages/db/tests/integration/task-submissions.test.ts` pins admission/key-change
races and rejection after revocation.

## Authenticated outbound command pull

`POST .../runtime-nodes/:runtimeNodeId/commands/pull` accepts only the paired
node's active verified Ed25519 proof. It never resolves or mints a user session.
Pairing, rotation and revocation retain their user authorization. Node possession
grants only its delivery/liveness boundary, never administration or history access.

The exact streamed-byte-bounded 1 KiB body is `{ version: 1, keyId, nonce,
issuedAt, signature }`. UUIDs, UTC millisecond timestamps and 64-byte base64url
signatures must be canonical. The signed bytes are UTF-8 JSON serialization of
`['adea-runtime-node-delivery', 1, 'commands.pull', workspaceId, runtimeNodeId,
keyId, nonce, issuedAt]`; `@adea-ai/types/runtime-node-delivery` supplies the
shared builder and WebCrypto verifier. Validity is two minutes with at most
30 seconds of future skew. Operation/scope binding cannot authenticate pairing,
rotation, another workspace or another node.

Each verified pull atomically claims a durable node/nonce identity. A node has
60 pulls per minute including empty polls; replay is 409 and exhaustion is 429
with Retry-After. Foreign/retired keys, revoked nodes and unavailable workspaces
share a refusal. Invalid proofs consume nothing. Request records retain both
the proof window and a full minute of rate accounting; they hold no signature,
private key, credential or content.

`pruneRuntimeNodeDeliveryRequests` deletes at most 1,000 expired records using
SKIP LOCKED, retaining the full minute rate window even for old proofs. An
operator schedules it; no in-process timer determines replay correctness.

Expired Task submission ciphertext has a separate
[workspace-scoped cleanup contract](remote-content.md#cloud-relay-ciphertext-retention).
It removes the outbox envelope while retaining submission, node/key identity and
all execution/history state. The supported operator entry defaults to dry-run;
neither nonce cleanup nor ciphertext cleanup is host acknowledgement or
execution cancellation. Production scheduling remains separately configured.

The transaction preserves admission's membership/workspace, Task, Agent, node
and key lock order. It rechecks the original owner/admin, Task version,
project, Agent pin/revision, node and expiry before releasing one envelope.
Legacy actors are recovered only from unambiguous queue audit provenance;
missing authority remains withheld. Node possession cannot replace it.

Valid pulls update proof/last-seen timestamps. The first proof per minute emits
`runtime_node.proof_accepted` with an explicit `runtime_node` actor; every pull
remains in the nonce ledger. Responses are private/no-store and set no session
cookie. The separate client omits user credentials, rejects redirects and has
a five-second native Fetch deadline including response-body reading.

Delivery is at least once: reconnect obtains the same command, submission,
request identity and ciphertext. Pull never acknowledges delivery, creates an
attempt or changes Task lifecycle. Durable host inbox/receipts, local policy,
SDK acceptance/reconciliation and deployed outbound host operation remain.

The boundary is pinned by the runtime-node-delivery integration suite and the
shared-message, bounded request and API-client tests in their owning packages.

## What pins this

- `packages/db/tests/integration/runtime-nodes.test.ts` — pairing and resume,
  the second device, exchange-credential single use and binding, challenge
  replay/expiry/purpose/node binding, the role↔algorithm rule at both layers,
  rotation ordering, revocation semantics, sign-out and account-switch
  boundaries, cross-workspace invisibility, the read model, the durable log,
  retention, cross-node proof binding, stable Control Plane node references,
  default/backfill uniqueness, and reference grammar/uniqueness constraints.
- `apps/web/test/runtime-node-proof.test.ts` — real Ed25519 signatures: exact
  message shape, tampering, replay across workspace/node/purpose/kind, an
  impostor key, and malformed input treated as failure rather than an exception.
- `apps/web/test/control-plane-discovery.test.ts` — actual public SDK fixtures,
  exact node/location binding, duplicate/cloud refusal, independent health,
  freshness, grants, compatibility and metadata-leak canaries.
- `packages/api-client/tests/unit/control-plane.test.ts` — encoded node discovery
  requests alongside the catalog and credential API contracts.
- `apps/web/start/browser/runtime-nodes.e2e.ts` — the whole flow against an
  isolated host and PostgreSQL, including the desktop-origin guard.
- `scripts/event-stream-authorization-boundary.test.ts` — the stream authorizes
  with `workspace.events.read` at both the first byte and the mid-stream
  recheck, and every role that can read a workspace holds it.
