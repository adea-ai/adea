# Local chat attachment producer boundary (#1392)

The production desktop host now serves authorized local attachment upload,
open and remove operations. The [normative contract](../specs/dev-runtime.md#local-chat-attachments-1392)
specifies the exact DTOs, scope, byte/type bounds, storage and transcript rules.
This is a producer/local-host increment; it does not claim a working composer
picker, harness attachment delivery or packaged owner journey.

## Supported behavior

- `dev.session.attachmentUpload` and `attachmentRemove` use existing session-
  manage authority; `attachmentOpen` uses session-read authority. Commands bind
  account/workspace/node, canonical session and current generation. No new
  access grants or credentials are minted.
- Nonempty UTF-8 `text/plain` input up to 128 KiB, with safe ASCII `.txt`, `.log`,
  `.md` or `.json` display names. Open returns canonical encoded bytes with
  `disposition: 'inert_text'`, never a path, public URL or OS execution receipt.
  Unsupported media, extensions, byte sizes, encodings and control characters
  refuse rather than silently choosing a different transport or renderer.
- Scope-specific owner-only SQLite storage, an existing read-only device-key
  boundary, HKDF key separation, authenticated per-record encryption and a
  MAC-protected durable transcript outbox. Filename, content digest and bytes
  remain sealed; transcript facts contain only opaque IDs, type, size and state.
- Atomic upload/remove, stable retry identity, tombstones, live generation fences,
  bounded record/byte quotas, interruption recovery and linearized open/remove.
  Unknown/evicted outbox history requires recovery instead of a duplicate event.
- The existing owner-proven workspace cleanup validates and purges attachment
  records. Foreign/sibling scope data and device keys are preserved; ambiguous
  ownership, additional authority for the same workspace, unsafe paths or
  unreadable records block cleanup before destructive effects.

## Shared integration

Isolated modules:

- `packages/types/src/dev-runtime-attachments.ts` — DTOs, limits and strict
  request/reference/reply/event-payload validation.
- `apps/desktop/shell/src/dev-runtime/attachments/{store,register}.ts` — local
  storage/transaction/outbox authority and the existing channel-provider seam.

Shared seams:

- Normative `dev-runtime-operations.json` plus generated registry, metadata and
  three operation-metadata leaves. The operation-count ratchet deliberately
  advances from 238 to 241; capabilities are reused, not broadened.
- `packages/types/src/dev-runtime.ts` adds named-body and strict success-reply
  decoders/re-exports; `dev-runtime-wire.ts` validates the two authoritative
  attachment transcript kinds.
- Desktop host composition registers the providers; `workspace-local-data.ts`
  includes authenticated attachment ownership/purge in its existing cleanup gate.
- Composition, workspace-data and contract-ratchet tests exercise those seams;
  Dev Runtime and local-content specs document the behavior in the same change.

No external donor implementation was copied. The new authority extends Adea's
existing channel, device-key, SQLite, authenticated-encryption, canonical event
log and owner-proven workspace-cleanup patterns. No cloud schema, dependency,
lockfile, UI416, consumer1385 or user-owned transcript-history1396 source changes
are included. PR #1401 remains on its separate unchanged branch.

## Validation

The first regression confirmed that none of the three attachment operations
existed. Focused development also caught and corrected a missing owner-header
column read, an unsupported-root construction behavior, and cleanup-path owner/
sidecar checks. Commit-hook review also caught cleanup-error masking; those
paths preserve the original failure without lint suppression. Initialization
now refuses unrelated SQLite files and commits its schema/owner header atomically.
Operation-specific success replies reject contradictory upload/remove state.
The final validation covers the actual composed provider,
signed channel, maximum control-frame upload and the existing native purge.

| Command                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Result                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Passed; Bun 1.4.0, lockfile unchanged; 229 GiB free before install            |
| `bun test packages/types/tests apps/desktop/tests/dev-runtime-chat-attachments*.test.ts apps/desktop/tests/workspace-local-data.test.ts apps/desktop/tests/workspace-cleanup*.test.ts apps/desktop/tests/dev-runtime-composition.test.ts apps/desktop/tests/dev-runtime-harness*.test.ts apps/desktop/tests/harness-events-channel.test.ts scripts/docs-boundary.test.ts scripts/dev-runtime-call-conformance.test.ts scripts/desktop-ipc-boundary.test.ts scripts/desktop-origin-boundary.test.ts scripts/desktop-auth-boundary.test.ts` | 431 passed, 0 failed across 37 files                                          |
| `bun test --conditions=browser packages/dev-view/tests`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 890 passed, 0 failed across 83 files; consumer source unchanged               |
| `TURBO_CONCURRENCY=1 bun run typecheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 31 tasks passed                                                               |
| `TURBO_CONCURRENCY=1 bun run lint`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 17 package tasks plus root lint passed                                        |
| `TURBO_CONCURRENCY=1 bun run build`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 15 tasks passed, including client/server web build and UI-source verification |
| `node scripts/generate-dev-runtime-contract.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Generated the three new operations and metadata                               |

Regression cases include foreign account/workspace/node/session, stale generation
and a generation change just before commit, wrong capabilities/resource/proof,
replayed/revoked channels, unsupported formats, canonical base64 and exact byte
bounds, invalid UTF-8/control content, traversal/unsafe names and IDs, key/store/
sidecar symlinks, encryption and redaction, database relabelling/corruption,
forged outbox metadata, record/byte quotas, retries after reopen, all upload and
remove interruption stages, ambiguous recovery after retention, open/remove
ordering, no egress, scope-safe purge and unknown-artifact preservation. Test
keys, databases, drivers and temporary repositories are disposable fixtures;
no old Pi/Claude session or user credential was changed.

## Remaining integration and qualification

1. Composer picker/chips, upload progress/error presentation and metadata-only
   lookup/list affordances are not implemented in the separately owned consumer.
2. Associating references with a particular sent user message and delivering
   their bytes/references into a native/ACP harness prompt need a reviewed
   producer/consumer contract. `attachment.added` proves local storage, not
   delivery to or understanding by an assistant.
3. Binary/image/HTML/SVG/archive attachments and transfers above 128 KiB are
   explicitly unavailable. There is no new bulk stream, remote/cloud store,
   external upload, public download URL, OS opener or malware-scanning claim.
4. The existing device key is file-backed. Missing/unsafe keys refuse; this
   increment does not provision keys, repair the legacy rotation gap or claim
   an OS-keyring implementation.
5. Tombstones occupy the bounded 256-record scope budget until owner-proven
   workspace purge. There is no attachment GC or special recovery UI; an outbox
   whose dedupe evidence has been evicted returns `recovery_required`.
6. Packaged/live-harness, browser owner-journey, remote-runtime and long-soak
   qualification were not run. Runner-heavy CI remains a later ready/review gate;
   this branch is only a draft and no ready, merge, deployment or release action
   is authorized.
