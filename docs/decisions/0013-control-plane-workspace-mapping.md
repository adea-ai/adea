# Control Plane Workspace and Project Mapping

- Status: Accepted (2026-10-06).
- Date: 2026-10-06
- Extends: [ADR 0011](0011-unified-workspace-projects.md) (workspaces and
  projects as the isolation boundary) and
  [ADR 0012](0012-workspace-memory-connections-sharing.md) (memory,
  connections, sharing), which this decision amends for cloud connections.
- Scope: how an Adea workspace and project become Control Plane scopes, how
  Adea authenticates to the Control Plane per request, and which Control Plane
  capabilities are scoped by them: marketplace installations, skills and
  agent profiles, project state for executions, and cloud connection
  credentials.

## Context

The Control Plane is the backend authority for profiles, skills, project
state, executions, the marketplace and connector credentials. Its scopes are
opaque Workspace (`wsp_`) and Project (`prj_`) identifiers that the caller
asserts and that a signed service credential authorizes; it keeps no
workspace or project registry of its own.

Adea currently reaches it through one static, year-long service token scoped to
a single configured Control Plane workspace, and its marketplace proxy replaces
every Adea workspace with that one scope. Every Adea workspace therefore shares
one set of marketplace installations and one idempotency namespace, which
defeats the isolation ADR 0011 makes the point of a workspace. Skills, project
state and cloud credentials have no Adea mapping at all.

## Decision

### Adea mints and owns the mapping

Each Adea workspace receives one Control Plane workspace identifier and each
Adea project one Control Plane project identifier, minted by Adea as a prefixed
ULID that satisfies the Control Plane identifier grammar, stored on the Adea
record, never reused and never derived from the Adea UUID. Identifiers are
minted on creation and backfilled once for existing rows. Task and agent
identifiers (`tsk_`, `agt_`) are minted the same way when executions are wired.
The mapping is Adea product state; the Control Plane remains free of an Adea
registry.

### Per-request signed credentials

Adea signs a short-lived Ed25519 JWT for every Control Plane request:

- `workspaceIds` holds exactly the request's mapped workspace, and
  `projectIds` the mapped project when the route is project-scoped;
- `scopes` are the minimum the route needs;
- lifetime is at most five minutes, with a key id that rotates by publishing
  overlapping public keys to the Control Plane's trusted keys.

The private key is a Worker secret that is never exposed to the client bundle.
Until it is provisioned, the existing static token and its configured
workspace remain the fallback, and the deployment reports that it is running
unscoped. Removing the fallback is a separate change after provisioning is
verified.

### What becomes workspace-scoped

- **Marketplace.** Catalog, install plans and installations use the active
  workspace's scope and its own idempotency namespace. The Control Plane gains
  get and uninstall for installations.
- **Skills and agent profiles.** Workspace-owned skills and profiles are
  published to and listed from the Control Plane under the workspace's scope,
  through a new authenticated catalog API, and managed from Workspace settings.
- **Project state.** Creating an Adea project initializes revision 0 of its
  Control Plane project state through a new authenticated API, so a cloud
  execution for that project can validate.
- **Cloud connections.** Connections that cloud executions and Control Plane
  tool calls need are stored in the Control Plane credential vault under the
  workspace's scope, through a new authenticated API with durable metadata and
  leases wired to the tool gateway. Device-local bindings (ADR 0012) remain
  the only source for local runs. A secret entered for a cloud connection
  travels to the vault once and is never returned to Adea.

### Memory stays local

Workspace memory remains restricted local content (ADR 0012). Cloud
executions run without it; no Control Plane memory route is added. A later
decision may introduce an opt-in export to a registered context provider.

## Amendment to ADR 0012

ADR 0012 said connection secrets never leave the device. That remains true for
device-local bindings. A workspace may additionally hold **cloud connections**
whose secret is written once to the Control Plane credential vault for cloud
executions; Adea stores only the credential identifier and status.

## Privacy classification

| Field                                    | Classification     | Leaves the device or Adea cloud |
| ---------------------------------------- | ------------------ | ------------------------------- |
| Control Plane workspace/project/task ids | workspace metadata | yes, to the Control Plane       |
| Signed request credential                | credential         | per request, five-minute expiry |
| Signing private key                      | credential         | never; Worker secret            |
| Cloud connection secret                  | credential         | once, into the vault            |
| Cloud connection id, provider, status    | workspace metadata | yes                             |
| Workspace memory                         | restricted local   | no                              |

## Consequences

- Marketplace isolation is fixed in Adea alone; the other capabilities need
  paired Control Plane changes, each with contracts, SDK operations, OpenAPI,
  Postgres and SQLite adapters and profile-portability coverage as that
  repository requires.
- Deploying signed credentials needs the owner to provision the key pair; the
  runbook lands with the signer.
- Control Plane routes that require project state (validate, accept) become
  usable for Adea projects once initialization ships.

## Delivery

Adea: the mapping and signer with workspace-scoped marketplace; then the
Workspace settings surfaces for skills and cloud connections, and project-state
initialization on project create, each after its Control Plane API lands.
Control Plane: project-state initialization and revision API; workspace
skill/profile catalog API; marketplace installation get and uninstall; the
credential-vault HTTP API with durable metadata, leases and tool-gateway wiring.

Status (2026-10-06):

- Adea mapping, signer and workspace-scoped marketplace: delivered.
- Control Plane project-state initialization, marketplace installation get
  and uninstall, and the workspace skill/profile catalog API: delivered.
- Adea project-state initialization on project create: delivered, signed
  credentials only, after the response with a lazy ensure path
  ([runbook](../control-plane-credentials.md)). The revision API and the
  project-scoped calls that consume it remain open.
- Adea marketplace installation get and uninstall, with an Uninstall action
  in Plugins: delivered ([marketplace consumer](../marketplace-consumer.md)).
- Workspace settings › Skills: delivered. Adea proxies the Control Plane
  workspace catalog (`/v1/catalog/{skills,profiles}/*`, contract 3.0) under
  `catalog:read`, `catalog:publish` and `catalog:manage`; the section (in the
  per-workspace settings dialog, not app Settings) lists workspace and read-only system items, publishes a skill from a pasted
  JSON manifest and content (shape-checked in the browser, validated by the
  Control Plane), and deprecates or revokes workspace items after a
  destructive confirmation. Agent profiles are listed and managed but not
  published from Adea; publishing a profile stays a Control Plane task.
- Workspace settings › Connections › Cloud: delivered in Adea against the
  Control Plane `feat/credential-vault-api` contract (`/v1/credentials/*`,
  `credential:read`, `credential:write`). It lists, adds, rotates and revokes
  vault credentials; Adea stores nothing for them and forwards the secret
  once, never returning it. Until that API is deployed the section reports
  that the Control Plane does not offer cloud connections yet.
- Both surfaces refuse the unscoped static-token fallback
  (`503 CONTROL_PLANE_UNSCOPED`) rather than write into its shared workspace
  ([runbook](../control-plane-credentials.md)).
- Static-token fallback: removed from Adea on 2026-10-07 after the signer was
  provisioned (runbook step 6); a deployment without the signing key fails
  closed with `503 CONTROL_PLANE_UNAVAILABLE`. Revoking the static credential
  on the Control Plane remains an owner action.
- Control Plane credential-vault HTTP API: open (in review upstream).

Workspace deletion ownership (local patch, 2026-10-07): fresh scopes record
`control_plane_used_at` before a mutating signed credential is issued. The
conditional update serializes with workspace cleanup preparation; unresolved
legacy scopes are conservatively marked used. Read-only catalog requests and
shared host authentication do not become workspace-owned resources. Used or
unverified scopes require a future workspace purge receipt and remain intact;
revocation/uninstall alone is not a complete purge. The local/database desktop
path can finish only after local ownership verification. This adds ownership
accounting and a bounded safety block, not a new Control Plane purge API.

Active workspace preparation/final deletion is additionally blocked until the
server can verify native cleanup completion. Neither a desktop-origin header nor
pending intent proves a purge; native pending retries preserve data and identity.
