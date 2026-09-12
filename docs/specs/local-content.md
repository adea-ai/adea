# Spec: local content authority

The encrypted local store for private Task and Message content. This page is the
contract to read before touching
`apps/desktop/src-tauri/src/local_content.rs`; the decision behind it is
[ADR 0003](../decisions/0003-local-private-content-authority.md).

**Changelog discipline:** a change to the behaviour described here lands in the
same commit as the update to this page (see `.github/CONTRIBUTING.md`).

## What is stored

`local-content.sqlite3` in the app data directory, opened with WAL and foreign
keys. Three tables:

- `local_content_records` — one row per content item: `content_id`,
  `workspace_id`, `content_type`, optional `task_id`/`message_id`, `revision`,
  `digest_sha256`, the product metadata (`sensitivity`, `storage_policy`,
  `synchronization_policy`, `availability`), `schema_version`, `key_version`,
  `nonce`, `ciphertext`, timestamps, and `deleted_at` for tombstones.
- `local_content_metadata` — schema and current key version.
- `local_content_rotation` — the resumable rotation row (old/new version, last
  migrated content ID, start time).

Content types are `message_body`, `task_objective`, `task_input`, and
`private_field`. Identifiers are canonical UUIDs, never row IDs or paths.

## Encryption

Each record is encrypted independently with AES-256-GCM under a random 256-bit
master key. The 96-bit nonce is per write and never reused. Authenticated
associated data binds `schemaVersion || keyVersion || workspaceId || contentId ||
contentType`, so ciphertext cannot be moved between records or workspaces.

Master keys live in the operating-system credential store only — service
`com.adea.desktop.local-content`, entry `master-key-v{version}` — and are never
written to SQLite, returned to the renderer, or logged. A missing or unreadable
key is an explicit unavailable state, never a fabricated plaintext.

## Key rotation

Rotation is resumable and bounded to 500 records per batch. A durable row records
the old and new versions; each batch commits ciphertext and progress atomically;
the old key is deleted only after every live row authenticates and its digest
verifies under the new key. `local_content_rotate_key` resumes from the row.

## Who may call it

Two independent checks, both required:

1. **Trusted window** — the call must come from the `main` window, whose URL is
   the packaged app scheme (or the local Vite origin in development). The check
   lives in `window_trust.rs` and is shared with the capability snapshot command.
2. **Authorized workspace** — the renderer first calls
   `local_content_authorize_workspace` with the workspace ID that bootstrap just
   authorized. The store holds a single active workspace: authorizing another
   clears the previous one, and every other command re-checks membership.

Inputs are bounded: 2 MiB of plaintext per record, UUID validation everywhere,
parameterized SQL, and bounded search results. Returned errors are generic and
carry no plaintext, key material, or cryptographic detail.

## Health

`LocalContentState::store_health()` is the single answer to "is the store
usable": an open repository whose key is readable. The `local_content_health`
command reports it for an authorized workspace, and the capability snapshot
reports the same flag as the `localContent` capability, so the two views cannot
disagree.

## Pinned by

- `local_content.rs` unit tests: ciphertext-at-rest with cross-workspace and
  AAD substitution attempts, workspace scoping, search bounds and no plaintext
  index, idempotent create, revision-checked update and tombstone, resumable
  rotation with key retirement, error messages that do not echo plaintext.
- `window_trust.rs` unit tests: packaged, lookalike, and navigated origins.
- `scripts/desktop-ipc-boundary.test.ts`: the `local_content_*` command surface,
  its grant, and the client's calls.
