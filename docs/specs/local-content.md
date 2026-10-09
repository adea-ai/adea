# Spec: local content authority

The encrypted local store for private Task and Message content. This page is the
contract to read before touching
`apps/desktop/shell/src/commands.ts`; the decision behind it is
[ADR 0003](../decisions/0003-local-private-content-authority.md).

> **Implementation note (2026-09-12):** the desktop shell is now Electrobun
> (Bun + CEF); see [ADR 0006](../decisions/0006-browser-lanes-and-desktop-shell.md).
> Rust module paths below refer to the previous shell. The shell implements the
> `local_content_*` commands in `apps/desktop/shell/src/commands.ts` over a
> file-backed AES-GCM store; the client reaches them through
> `apps/web/src/lib/desktop-bridge.ts` (module
> `apps/web/src/lib/desktop-local-content.ts`).

## Current implementation and target limits

The current command registry stores an `index.json` and individually sealed
content files under `local-content`. It uses the shared `desktop-state/device.key`
file for AES-GCM encryption. It does not implement the SQLite tables, OS keyring
master keys, or resumable rotation described in the target sections below.

The signed shell channel checks the calling window. In this command registry,
`local_content_authorize_workspace` is a no-op, and reads, updates, and deletes
look up the content ID without a workspace-membership check. Content ID
validation is present, but it is not proof of workspace authorization. Record
creation currently leaves `digestSha256` empty, and `local_content_health`
returns a constant successful result rather than checking the repository and key.

`local_content_rotate_key` deletes the shared key file without re-encrypting
existing content, user sessions, pending auth attempts, or temporary workspace
credentials. The next key access creates a new key. Existing ciphertext then fails
to open under it. These are source-level implementation gaps; the target
requirements below must not be treated as verified current behavior.

**Changelog discipline:** a change to the behaviour described here lands in the
same commit as the update to this page (see `.github/CONTRIBUTING.md`).

## What is stored

This section describes the target contract, subject to the current limits above.

`local-content.sqlite3` in the app data directory, opened with WAL and foreign
keys. Three tables:

- `local_content_records`: one row per content item: `content_id`,
  `workspace_id`, `content_type`, optional `task_id`/`message_id`, `revision`,
  `digest_sha256`, the product metadata (`sensitivity`, `storage_policy`,
  `synchronization_policy`, `availability`), `schema_version`, `key_version`,
  `nonce`, `ciphertext`, timestamps, and `deleted_at` for tombstones.
- `local_content_metadata`: schema and current key version.
- `local_content_rotation`: the resumable rotation row (old/new version, last
  migrated content ID, start time).

Content types are `message_body`, `task_objective`, `task_input`,
`private_field`, and `memory_entry` (workspace memory, below). Identifiers are
canonical UUIDs, never row IDs or paths.

## Encryption

This section describes the target contract, subject to the current limits above.

Each record is encrypted independently with AES-256-GCM under a random 256-bit
master key. The 96-bit nonce is per write and never reused. Authenticated
associated data binds `schemaVersion || keyVersion || workspaceId || contentId ||
contentType`, so ciphertext cannot be moved between records or workspaces.

Target master keys live only in the operating-system credential store under service
`com.adea.desktop.local-content`, entry `master-key-v{version}`, and are never
written to SQLite, returned to the renderer, or logged. A missing or unreadable
key is an explicit unavailable state, never a fabricated plaintext.

## Key rotation

This section describes the target contract, subject to the current limits above.

Rotation is resumable and bounded to 500 records per batch. A durable row records
the old and new versions; each batch commits ciphertext and progress atomically;
the old key is deleted only after every live row authenticates and its digest
verifies under the new key. `local_content_rotate_key` resumes from the row.

## Workspace memory

[ADR 0012](../decisions/0012-workspace-memory-connections-sharing.md) adds the
`memory_entry` content type: short plain-text notes owned by exactly one
workspace and injected into harness sessions that launch there
([dev-runtime.md](./dev-runtime.md), "Initial prompt delivery"). This section
describes the shipped implementation, not the SQLite target.

**Record.** One owner-only (`0600`) JSON file per entry under
`local-content/memory/<id>.json`, written atomically (temp file plus rename).
The entry shape is `{ id, workspaceId, text, source, status, createdAt,
updatedAt, revision }` (`WorkspaceMemoryEntry` in `@adea-ai/types`): `id` is a
random canonical UUID, `source` is `user` or `agent`, `status` is `active` or
`pending`, and `revision` starts at 1. Only the text is sealed: AES-256-GCM
under the device key with a fresh 96-bit nonce per write, and associated data
`schemaVersion || keyVersion || workspaceId || contentId || contentType`
(`\u001f`-joined, content type `memory_entry`). Id, workspace, source, status,
timestamps and revision are workspace metadata stored beside the ciphertext.

**Workspace binding.** Every read authenticates under the workspace the caller
is authorized for, never the workspace the file claims. A record copied or
re-labelled into another workspace therefore fails authentication; it is
counted as `unreadable` in the list result and is never shown, injected or
promoted. Lookups by id that name another workspace's entry read as
`memory_not_found`, so existence never leaks across workspaces.

**Bounds.** Entry text is trimmed, 1–2,000 UTF-16 code units, and contains no
NUL; `\r\n` normalizes to `\n`. A workspace holds at most 200 entries
(active plus pending) and at most 20 pending proposals; the next write refuses
`memory_limit_exceeded`. The compiled launch preamble is at most 16 KiB
(`workspaceMemoryLimits` in `@adea-ai/types`).

**Commands.** The trusted shell command family, registered in
`apps/desktop/shell/src/commands.ts` behind the signed legacy invoke gate:

| Command                  | Arguments                                            | Result                                      |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------- |
| `memory_list`            | `workspaceId`                                        | `{ entries, injectionEnabled, unreadable }` |
| `memory_create`          | `workspaceId`, `text`                                | the new `active`, `user` entry              |
| `memory_update`          | `workspaceId`, `entryId`, `expectedRevision`, `text` | the entry at `revision + 1`                 |
| `memory_delete`          | `workspaceId`, `entryId`, `expectedRevision`         | `null`                                      |
| `memory_accept_proposal` | `workspaceId`, `entryId`, `expectedRevision`         | the entry, now `active`                     |
| `memory_reject_proposal` | `workspaceId`, `entryId`, `expectedRevision`         | `null` (the proposal is deleted)            |
| `memory_injection_save`  | `workspaceId`, `enabled`                             | `{ injectionEnabled }`                      |

Entries list newest first (creation time, then id). Accept and reject apply
only to `pending` entries (`memory_invalid_state` otherwise), and every
mutation is revision checked (`memory_stale_revision`).

**Authorized workspace.** Unlike `local_content_authorize_workspace` (a no-op
in this registry), memory commands are gated by the shell itself: the named
`workspaceId` must equal the workspace of the shell's active Dev scope
(`DesktopIdentityAuthority.currentScope()`), or the command refuses
`memory_workspace_unauthorized`. A command surface built without that
authority fails every memory command closed. The harness launch path reads the
same store with the session's own `scope.workspaceId`, so the settings UI and
injection always address the same workspace.

**Injection switch.** `local-content/memory-settings.json` keeps a
per-workspace `memoryInjection` flag; absent means on. Turning it off stops
launch injection and deletes nothing.

**Proposals.** Agent-written entries arrive through the Dev operation
`dev.memory.propose` ([dev-runtime.md](./dev-runtime.md), "Command catalog")
and are stored `pending` with source `agent`; pending entries are never
injected. A rejected proposal is deleted, not tombstoned.

**Errors.** Refusals carry only a stable code — `memory_invalid_input`,
`memory_not_found`, `memory_stale_revision`, `memory_limit_exceeded`,
`memory_invalid_state`, `memory_workspace_unauthorized`, or
`memory_unavailable` for any filesystem or cryptographic failure — and never
entry text, paths or key detail.

**Not yet shipped.** Memory entries are `local_only` in this implementation:
publishing them as `agent_hq_e2ee_sync` ciphertext replicas (ADR 0012) needs
the cloud content-ref schema to admit `memory_entry` and lands separately.
`local_content_rotate_key` deletes the shared device key, after which existing
memory records fail authentication and report as `unreadable`, the same
documented gap as the rest of the transitional store.

## Cloud replica boundary

When a workspace enables `agent_hq_e2ee_sync`, the local authority may publish
an encrypted physical revision through the cloud `ContentReplica` contract
([content-replicas.md](./content-replicas.md)). The local store remains the
plaintext authority and keeps its master key private; cloud persistence holds
only ciphertext, nonce, digest, and bounded revision metadata. Local-only
content continues to report an explicit unavailable state when its authority is
offline.

## Who may call it

This section describes the target contract, subject to the current limits above.

Two independent checks, both required:

1. **Trusted window**: the call must come from the app's own window. In the
   Electrobun shell this is the M10 channel gate
   (`apps/desktop/shell/src/dev-runtime/channel/`): the window authenticates
   with a single-use launch bootstrap at `dev.runtime.handshake.v1` and signs
   every request, so loopback presence, a rebinding host, or a cross-origin
   page never reaches a handler.
2. **Authorized workspace**: the renderer first calls
   `local_content_authorize_workspace` with the workspace ID that bootstrap just
   authorized. The store holds a single active workspace: authorizing another
   clears the previous one, and every other command re-checks membership.

Content identifiers are canonical ids, never paths: every command that turns
an id into a filename validates it against the minted id shapes (128-bit hex
or canonical UUID) first, so a hostile `contentId` is rejected instead of
resolving outside the content directory.

Inputs are bounded: 2 MiB of plaintext per record, UUID validation everywhere,
parameterized SQL, and bounded search results. Returned errors are generic and
carry no plaintext, key material, or cryptographic detail.

## Health

This section describes the target contract, subject to the current limits above.

`LocalContentState::store_health()` is the single answer to "is the store
usable": an open repository whose key is readable. The `local_content_health`
command reports it for an authorized workspace, and the capability snapshot
reports the same flag as the `localContent` capability, so the two views cannot
disagree.

## Pinned by

The Rust tests below describe historical evidence for the target contract.
Current shell channel and command-boundary tests cover their stated boundaries;
they do not establish the missing SQLite, workspace, health, or rotation behavior.

- `local_content.rs` unit tests: ciphertext-at-rest with cross-workspace and
  AAD substitution attempts, workspace scoping, search bounds and no plaintext
  index, idempotent create, revision-checked update and tombstone, resumable
  rotation with key retirement, error messages that do not echo plaintext.
- `window_trust.rs` unit tests: packaged, lookalike, and navigated origins.
  (The Electrobun lane's equivalent lives in
  `apps/desktop/tests/shell-channel.test.ts`: origin/rebinding refusals,
  bootstrap single use, and content-id traversal rejection.)
- `scripts/desktop-ipc-boundary.test.ts`: the `local_content_*` and `memory_*`
  command surface, its grant, and the client's calls.
- `apps/desktop/tests/workspace-memory-store.test.ts`: encrypted round trip,
  cross-workspace refusal (including a re-labelled record failing
  authentication), revision checks, bounds, the proposal lifecycle, the
  injection switch, and the authorized-workspace gate on every `memory_*`
  command.
- `apps/desktop/tests/workspace-memory-launch.test.ts`: launch injection and
  `dev.memory.propose` over the real channel gate (see dev-runtime.md).

### Workspace deletion cleanup

The shell's `workspace-local-data.ts` verifies ownership before deleting indexed
`local-content/<id>.sealed` ciphertext and workspace memory records. Memory
records authenticate their workspace-bound AES-GCM associated data before purge;
malformed ownership, symlinks, an unreadable record or another device/account scope
for the same workspace refuses cleanup. The memory injection override is removed.
Ciphertext is unlinked before its index entry so interrupted cleanup can retry.
The signed-window cleanup protocol persists completed phases and never reports an
unknown filesystem state as complete. Deletion fences also check the stored owner
of legacy content read/update/delete commands, so a forged renderer workspace ID
cannot bypass a pending or completed deletion fence. Account-wide keys and other
workspace content are retained.

The persistent personal workspace is excluded from deletion proof and preparation; its memory and local content remain after renaming or changing settings. Additional-workspace cleanup preserves all personal and sibling scope data.

Active permanent workspace deletion is blocked until the server can verify native
cleanup completion. A prepare/pending timestamp never authorizes local ciphertext
or memory removal. Native recovery cleanup requires fresh proof that a historical
cloud root is already deleted; interrupted pending/restart/retry retains local data.
