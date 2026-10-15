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
  without delimiter collisions, and allocates sequences only after dedupe.
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
round-trip unchanged.

Passing checks on the implementation:

| Command                                                                                                                                                                                   | Result                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                                                                                                                                           | Passed; pinned Bun 1.4.0, lockfile unchanged                                    |
| `bun test packages/types/tests apps/desktop/tests/dev-runtime-harness*.test.ts apps/desktop/tests/harness-events-channel.test.ts apps/desktop/tests/dev-runtime-assistant-events.test.ts` | 336 passed, 0 failed across 27 files                                            |
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
