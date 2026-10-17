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

## Independent review repairs (#1407)

The four reported P2 regressions reproduced at
`2cf2f8c9cd941342a274bd861b17ce01af17a198`: the initial focused run had
33 passes and exactly four failures. Swapping two valid rows' upload-key/
fingerprint pairs returned the wrong attachment; changing a pending delivery
flag suppressed its event; complete generation eviction after publication
allowed another cursor; Error-derived refusals lost `message` and leaked `name`
through JSON serialization. The first two require local database modification
without the encryption key. They are local integrity failures, not evidence of
remote privilege escalation.

The repaired store seals the retry key and fingerprint with the attachment,
checks them before evaluating a retry, and retains them in encrypted tombstones.
Its outbox MAC now authenticates the publication state. All outbox rows,
including delivered rows and their binding selectors, authenticate before
filtering, skipping or owner-proven purge. Before appending to the separate
canonical log, the host persists an authenticated attempted state. An attempted
fact missing from retained history returns `recovery_required`, even when no
history remains in that generation. This deliberately also refuses an ambiguous
interruption between the attempted marker and the append itself. Retained
facts still reconcile through the original source identity; delivered retries
do not republish after retention.

Attachment-store format 2 does not automatically adopt format 1: its retry and
delivery metadata cannot be retroactively trusted. Old draft stores are
preserved and refused with `unsupported_version`; no user data or credentials
are rewritten or deleted. This does not add protection against arbitrary row
removal, whole-database rollback or an actor holding the device key.

The shared `channel/authority.ts` repair uses the identical `wireDevError`
projection and both call sites inspected in usage PR #1397 at
`99e4941e82e5515cf9cc1bf9f18f9d6f1a15ca75`. It explicitly serializes the public
error fields, including `message`, and excludes class names/stacks. No usage
semantics or second helper were imported. This is the only additional shared
source integration beyond the original attachment PR; schema/barrel and
operation-registry changes were not needed for these repairs. Integration should
retain one copy of this shared helper when both drafts land.

Repair validation:

- `bun test packages/types/tests apps/desktop/tests/dev-runtime-chat-attachments*.test.ts apps/desktop/tests/workspace-local-data.test.ts apps/desktop/tests/workspace-cleanup*.test.ts apps/desktop/tests/dev-runtime-composition.test.ts apps/desktop/tests/dev-runtime-harness*.test.ts apps/desktop/tests/harness-events-channel.test.ts apps/desktop/tests/shell-channel.test.ts apps/desktop/tests/terminal-channel.test.ts apps/desktop/tests/terminal-input-authority.test.ts apps/desktop/tests/dev-runtime-dispatch-local.test.ts scripts/docs-boundary.test.ts scripts/dev-runtime-call-conformance.test.ts scripts/desktop-ipc-boundary.test.ts scripts/desktop-origin-boundary.test.ts scripts/desktop-auth-boundary.test.ts`:
  **502 passed, 0 failed across 41 files**. Includes the four review regressions,
  additional publication-state/binding tamper cases, ambiguous pre-append
  interruption, stable delivered retries after full eviction, old-format byte/key
  preservation, purge authentication, and
  signed plus local refusal JSON round trips through `decodeDevReply`.
- `TURBO_CONCURRENCY=1 bun run typecheck`: **31 tasks passed**, 30 cached.
- `TURBO_CONCURRENCY=1 bun run lint`: **17 package tasks plus root lint passed**,
  16 package tasks cached; zero warnings/errors.
- `TURBO_CONCURRENCY=1 bun run build`: **15 tasks passed**, all cached.
- `bun build --target=bun apps/desktop/shell/src/dev-runtime/attachments/register.ts --outdir /tmp/1392-repair-host-bundle`:
  fresh Bun host bundle passed (15 modules).
- `node scripts/generate-dev-runtime-contract.mjs`: deterministic; no generated
  file changes. `bunx --no-install code-foundry doctor`: passed.

Heavy job concurrency remained one, with 229 GiB free and existing dependencies
reused. No consumer code changed; the earlier 890-test consumer result above is
historical, not rerun for this host-only repair. Packaged/live/browser/remote/soak
qualification remains unrun. PR #1401 stays on its original exact head; PR #1407
remains draft with auto-merge disabled. No production action was taken.

## Prepared outbox retry correction

At `b279d1be410166633916d39fe5ce5789e6655037`, authenticated format-2
prepared rows (`delivered=0`) still encountered the older retained-floor
heuristic on retry. Upload and remove both reproduced `recovery_required` after
an `after_commit` interruption when earlier transcript events already had a
retained floor above 1 (39 focused tests passed; these two failed).

Prepared is authenticated proof that publication has never been attempted. The
store now permits these rows to publish at the next canonical sequence regardless
of the retained floor. The process-local `fresh` exception is no longer needed.
Attempted rows still require their original source identity in retained history;
partial or complete eviction remains `recovery_required`. Delivered rows still
authenticate before skipping. No format, MAC, encryption, access or wire schema
was changed in this correction.

Both upload and removal retries now preserve the recovered descriptor and event
identity across reopen, above the previous canonical sequence. The affected test
command documented above passes **504 tests across 41 files**, including partial/
complete attempted-history eviction and all delivery/binding tamper regressions.
`TURBO_CONCURRENCY=1 bun run typecheck`, `lint` and `build` pass 31/17/15 tasks
respectively (30/16/15 cached); the root lint also passes. A fresh Bun host bundle
passes. One heavy command ran at a time; existing dependencies and hooks were
retained. Earlier qualification limits remain unchanged.
