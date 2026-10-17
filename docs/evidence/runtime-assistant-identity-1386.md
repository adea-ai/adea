# Runtime assistant message identity (#1386)

A streamed assistant message and its final now share a validated producer
identity. The known delta/message/result event kinds require `harnessRunId`
and payload `messageId`; delta payloads also require contiguous zero-based
`deltaIndex` and `text`, and finals require complete `text` plus
`supersedes: 'deltas'`. Results reference the message without fabricating a
final answer. The normative [event contract](../specs/dev-runtime.md#assistant-message-identity-1386)
defines the exact namespace and replay rules.

## Implementation boundary

- Isolated payload codec: `packages/types/src/dev-runtime-assistant.ts`.
- Isolated host append-order guard:
  `apps/desktop/shell/src/dev-runtime/harness/assistant-events.ts`.
- Shared integration: `dev-runtime-wire.ts` validates known assistant payloads
  and canonical uint64 sequences; `dev-runtime.ts` re-exports the payload
  codecs/types. No operation-registry, DB-schema, package-export, or lockfile
  changes are required.
- Canonical log integration: `harness/events.ts` validates before saving or
  publishing, rejects message gaps and invalid settlement, compares canonical
  payloads and run/provenance metadata for retries, encodes dedupe tuples
  without delimiter collisions, fences confidence downgrades, and allocates
  sequences only after dedupe.
- Existing stream integration test gains an assistant-specific final-only
  resync case. The source audit is updated to distinguish assistant identity
  validation from the still-opaque tool/approval/question contracts.
- No UI416, consumer1385, tool/subagent1387, citations1389, usage1391,
  questions/approvals1395, or transcript-history1396 implementation is changed.
  The shared wire/barrel and spec paragraphs are the integration points for
  those separately owned lanes.
- This extends Adea's canonical contract; no donor implementation was copied,
  and no new donor provenance or NOTICE row is needed.

## Regression evidence

The initial regression run reproduced nine failures: missing/malformed IDs,
missing run/supersession facts, invalid delta indexes, append gaps, late text,
and noncanonical retry comparisons were accepted. Two later adversarial cases
also failed before their fixes: delimiter-bearing opaque IDs collided, and an
exact retry at uint64 exhaustion failed before dedupe. A final round-trip
edge case showed that an unpaired UTF-16 surrogate could change identity during
CBOR encoding; those malformed IDs are now rejected, while valid Unicode IDs
round-trip unchanged. The confidence regression also reproduced a weaker
observation extending stronger text; the append guard now refuses downgraded
deltas, finals and results, while allowing an authoritative final to settle
bounded deltas.

Passing checks on the implementation:

| Command                                                                                                                                                                                   | Result                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                                                                                                                                           | Passed; pinned Bun 1.4.0, lockfile unchanged                                    |
| `bun test packages/types/tests apps/desktop/tests/dev-runtime-harness*.test.ts apps/desktop/tests/harness-events-channel.test.ts apps/desktop/tests/dev-runtime-assistant-events.test.ts` | 337 passed, 0 failed across 27 files                                            |
| `bun test --conditions=browser packages/dev-view/tests`                                                                                                                                   | 890 passed, 0 failed across 83 files; no consumer source edits                  |
| `bun test scripts/docs-boundary.test.ts scripts/desktop-ipc-boundary.test.ts scripts/desktop-origin-boundary.test.ts scripts/desktop-auth-boundary.test.ts`                               | 35 passed, 0 failed across 4 files                                              |
| `TURBO_CONCURRENCY=1 bun run typecheck`                                                                                                                                                   | 31 tasks passed, including dependency builds and web Cloudflare type generation |
| `bun run --cwd packages/types build`                                                                                                                                                      | Passed                                                                          |
| `bunx --no-install code-foundry doctor`                                                                                                                                                   | Repository doctor passed                                                        |
| `TURBO_CONCURRENCY=1 bun run build`                                                                                                                                                       | 15 tasks passed, including client/server web builds and UI-source verification  |
| `TURBO_CONCURRENCY=1 bun run lint`                                                                                                                                                        | 17 package tasks plus root lint passed                                          |
| `bun build --target=bun apps/desktop/shell/src/dev-runtime/harness/events.ts --outdir /tmp/1386-host-bundle`                                                                              | Passed; 15 host modules bundled                                                 |
| Scoped `oxlint --deny-warnings`                                                                                                                                                           | Passed                                                                          |

An initial direct desktop typecheck and harness launch test lacked generated
Dev View notification declarations. Building the dependency graph resolved
that setup prerequisite; the graph typecheck and subsequent harness suite
passed. This was not bypassed or fixed by changing another lane's source.

The stream regression appends a partial delta, final and result, then enough
unrelated events to move the newest-500 replay floor to the final. It asserts
an explicit checkpoint resync, the original final event/message identity and
complete replacement text, no replayed partial delta, the replay-end heartbeat,
no publication for a duplicate final or refused late delta, and a separate
message namespace when a new run reuses the source-local message ID.

## Remaining qualification

There is still no production structured assistant-event subscription/emitter
in this runtime. Future native/ACP/hook adapters must allocate/persist and
supply these IDs. The tests use scripted drivers and canonical log appends;
no old Pi/Claude session was started or restarted. No packaged/live-harness,
browser E2E, deployment, release, or soak qualification is claimed.

Legacy assistant payloads missing the required identity fail closed at the
wire boundary; they cannot silently supersede other prose. Existing consumer
unit tests pass, but adopting supersession in the chat canvas remains the
separate consumer lane. Retention is a bounded replay window, not a permanent
source-id ledger; adapters must resync rather than re-ingest evicted history.

## Retained opaque-payload correction

At `829e2d97c0a4bd254a69d1224b46ee497165790e`, the append-order guard
read a retained payload's `messageId` without first validating the remaining
kind-specific fields. Persisted legacy finals without `supersedes`, results
with a non-string summary, and deltas with missing/invalid index or text could
therefore impose settlement, confidence or index fences on a valid new event.
The focused regression reproduced all eight authoritative/bounded cases before
the fix (10 passed, 8 failed).

The guard now decodes every matching retained assistant payload before using
its message identity. Malformed retained payloads remain opaque historical data;
they do not establish lifecycle fences. Candidate validation, tuple scoping,
source-event idempotency, valid settlement, confidence ordering and delta-index
checks remain unchanged. No data migration, history rewriting, source-ID
reassignment, shared schema/barrel or consumer changes were needed.

The durable-log regressions reopen the actual persisted fixture, confirm the
legacy row still fails wire decoding, append a valid delta/final/result lifecycle
with stable next sequences, verify exact retry remains a no-op, preserve the
original opaque row and event ID, and confirm valid settlement still rejects
late text.

Validation:

- `bun test packages/types/tests apps/desktop/tests/dev-runtime-harness*.test.ts apps/desktop/tests/harness-events-channel.test.ts apps/desktop/tests/dev-runtime-assistant-events.test.ts scripts/docs-boundary.test.ts scripts/desktop-ipc-boundary.test.ts scripts/desktop-origin-boundary.test.ts scripts/desktop-auth-boundary.test.ts`:
  **380 passed, 0 failed across 31 files**.
- `TURBO_CONCURRENCY=1 bun run typecheck`: **31 passed**, 30 cached.
- `TURBO_CONCURRENCY=1 bun run lint`: **17 package tasks plus root lint passed**,
  16 package tasks cached.
- `TURBO_CONCURRENCY=1 bun run build`: **15 passed**, all cached.
- `bun build --target=bun apps/desktop/shell/src/dev-runtime/harness/events.ts --outdir /tmp/1401-retained-bundle`:
  fresh host bundle passed.

Existing hooks remain enabled, dependencies were reused, and heavy commands ran
one at a time. Consumer tests above are historical and were not rerun for this
host-only repair. Packaged/live/browser/remote/soak qualification remains unrun;
the production emitter and consumer adoption remain separate follow-up work.
The draft is retained for parent review; no readiness or merge action was taken.

## Main reconciliation and review corrections

Main advanced past the previous head with response citations (#1389) and
user-visible summaries (#1388), which edit the same wire module, canonical log
and event specification. The merge keeps both contracts and resolves the
overlap as follows.

- A cited final is the #1386 final plus references: exactly `messageId`,
  `text`, `supersedes: 'deltas'` and `references`. The reference validator
  accepts the identity fields; the assistant contract enforces them, so a cited
  payload without identity fails on append and on the wire. A retained row
  written before identity existed still passes the reference check on replay
  and stays opaque to the assistant lifecycle.
- The canonical log now decodes every candidate envelope, so an event kind
  outside the wire vocabulary is refused at append instead of being retained
  where no stream consumer could decode it. The #1388/#1389 replay tests that
  used a made-up kind now use the known unrelated kind `tool.progress`, and
  their assistant payloads carry identity.
- Append order is: reference validation, envelope decode, duplicate/retry
  check, summary admission, assistant lifecycle checks, then sequence
  allocation.

Review corrections found while reconciling:

- A final or delta could be appended at up to 65,536 UTF-16 units, but the
  `runtime-events-v1` handler sends each event as one 64 KiB frame and the
  gateway closes the stream on a larger frame. An interim 48 KiB JSON bound was
  not enough: it skipped `references` on delta/result events and CBOR expands
  numbers (8,000 values of `0.1` are 32 KB of JSON but over 64 KiB encoded). The
  canonical log now encodes the exact event to be stored, with its allocated
  sequence, and refuses one over 65,536 bytes before persistence or publication
  (`maximum encoded assistant event size exceeded`). Regressions cover the
  numeric expansion, references on delta/result/final events, the exact maximum
  and one byte more with 256-character envelope fields, and a stored event that
  fits as sequence 99 but not 100 (an exact retry stays a no-op). They fail
  without the check. A complete answer larger than the bound cannot be
  finalized under this contract; a chunked-final contract would be separate
  work.
- Delta and final `text` and result `summary` could contain an unpaired UTF-16
  surrogate, which UTF-8/CBOR replay rewrites to U+FFFD, so live and durable
  text would differ and a delta split mid-pair would corrupt the character.
  They are now refused, matching the message-ID and citation rules.

Validation on the reconciled tree:

- `bun test packages/types/tests`: 310 passed, 0 failed.
- `bun test tests` in `apps/desktop`: 1418 passed, 0 failed across 115 files.
- `bun test --conditions=browser packages/dev-view/tests`: 891 passed, 0 failed
  across 83 files (consumer source untouched).
- `bun test scripts/docs-boundary.test.ts scripts/desktop-ipc-boundary.test.ts scripts/desktop-origin-boundary.test.ts scripts/desktop-auth-boundary.test.ts scripts/client-bundle-budgets.test.ts`:
  52 passed, 0 failed.
- `TURBO_CONCURRENCY=2 bun run typecheck`: 31 tasks passed (uncached).
- `TURBO_CONCURRENCY=2 bun run lint`: 17 package tasks passed; `oxfmt --check .`
  clean; `git diff --check` clean; `code-foundry doctor` passed.
- Plain `vite build` in `apps/web` then `node start/check-client.mjs`: passed
  with caps unchanged (Dev utility panes 185,318 of 185,344; 167 of 167 files).
- `bun build --target=bun .../harness/events.ts`: host bundle passed.

No packaged/live-harness, browser E2E or soak qualification is claimed.

### Envelope identifier Unicode (review 5559261853)

`decodeRuntimeEvent` now rejects unpaired surrogates in `eventId`, `runtimeSessionId`, `sourceEventId` and `harnessRunId` before admission, dedupe or cursor allocation. The canonical CBOR encoder passes strings through `TextEncoder`, which rewrites a lone surrogate to U+FFFD, so `r\uD800` and `r\uD801` would otherwise share one wire identity while the host kept them distinct. The check uses `packages/types/src/dev-runtime-unicode.ts`, byte-identical to the helper on #1417's branch, so the two branches merge without divergent behaviour. Valid astral and combining identifiers are preserved through append, CBOR and replay.

Bundle budget after merging current main: the shared utility open view measured 185,455 B against the 185,344 B cap (main alone: 184,338 B). The assistant decoder now reuses the shared well-formed Unicode helper instead of a private regex and one shared text-field check, which brings the view to 185,289 B without changing any cap. The refusal message for lone surrogates in assistant text, summary and `messageId` is now the helper's `ill-formed Unicode string`.
