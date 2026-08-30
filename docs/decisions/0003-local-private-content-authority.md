# ADR 0003: Local/private content authority

- Status: Accepted
- Date: 2026-08-30
- Issue: #184

## Decision

Agent HQ Desktop is the developer-MVP authority for Local/private Task and Message content. Cloud persistence owns stable `ContentRef` identity and product-safe metadata, while plaintext is resolved only through a narrow Tauri command family backed by a separate embedded SQLite database.

Each record is encrypted independently with AES-256-GCM. Its authenticated associated data binds the schema version, key version, workspace ID, logical content ID, and content type. A fresh 96-bit nonce is generated for every create, update, and rotation write. The random 256-bit master keys are versioned in the operating-system keyring and are never stored in SQLite or exposed through renderer commands.

The renderer can request content operations only from the bundled `main` window. It must first register a UUID Workspace that the desktop bootstrap just authorized. Every later command repeats the trusted-window and active-Workspace checks. Inputs are bounded, UUID identifiers are canonicalized, SQL is parameterized, and returned errors contain no plaintext or cryptographic detail.

Logical content IDs are caller-supplied or generated UUIDs, never SQLite row IDs or paths. Create retries with the same logical identity and content are idempotent. Updates and tombstones use optimistic revisions. Missing keys, unavailable local storage, deletion, and authorization failures remain explicit states; stale or fabricated plaintext is never substituted.

Key rotation is resumable. A durable rotation row records the old/new key versions and last migrated content ID. Each bounded batch commits ciphertext and progress atomically. The old key is deleted only after all live rows are authenticated and their digests verified under the new key.

## Trust and abuse analysis

The protected assets are plaintext bodies and master keys. The relevant threats are a spoofed renderer, cross-Workspace access, copied/tampered SQLite files, swapped ciphertext, stale updates, oversized inputs, interrupted rotation, and leakage through errors/logs/cloud-shaped data. Controls are the exact window/origin check, Workspace allowlist, AES-GCM authenticated identity, OS keyring isolation, revision checks, size limits, SQLite transactions/WAL recovery, generic errors, and leak-canary tests.

The renderer necessarily receives plaintext after an authorized read so it can display or edit content. It never receives a key, nonce, ciphertext, database handle, or filesystem path. This boundary must not be broadened when the later general desktop privilege registry is introduced.

## Backup and restore

M2 explicitly excludes the local-content SQLite database and its keyring entries from Agent HQ exports and application-managed backups. Copying the SQLite file alone produces only ciphertext and is not a supported restore mechanism. A future backup feature must encrypt a portable envelope under separately reviewed user-held recovery material; it must never emit plaintext or silently copy the device master key.

## Consequences

- Web/mobile can display `ContentRef` metadata and an unavailable state without receiving Local/private plaintext.
- A future execution consumer can resolve an authorized Task/input `ContentRef` through this same trusted boundary without a live Control Plane during M2.
- Future E2E `ContentReplica` synchronization can attach physical replicas without changing Task, Message, Channel, or `ContentRef` identity.
- Private body text is prohibited from cloud fixtures, WorkspaceEvents, telemetry, crash output, logs, and persistent browser storage.
