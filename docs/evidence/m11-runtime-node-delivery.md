# M11 authenticated outbound runtime-node delivery

Recorded 2026-10-07 against implementation candidate
`492ca8eee666e9d78b7d147fbf9888e8293f4f94`. This increment supplies the cloud side of outbound command
pull for #38/#187/#188/#189. Host execution acceptance and whole-milestone
certification remain unverified.

A paired node signs the exact operation, workspace, node, key, nonce and issuance
time with its verified active Ed25519 key. The HTTP boundary accepts a strict,
streamed-byte-bounded proof body and releases one fixed metadata projection plus
the original HPKE envelope. It uses no user token, cookie, session lookup or
session minting. The separate public client omits credentials, refuses redirects,
and bounds native Fetch time and response bytes.

The transaction rechecks the original submitting owner/admin, workspace/project,
Task version, exact Agent profile/revision, node state, signing key, envelope
recipient and expiry. Revoked authority or stale references withhold ciphertext.
An encryption key retired after admission can serve that unchanged envelope
within its own expiry and the 24-hour grace; a retired signing key cannot
authenticate. The host still owns private-key retention and local policy.

A durable nonce claim prevents replay across process replacement and serializes
concurrent pulls. The node has 60 authenticated requests per minute, including
empty polls. Records retain the full proof and rate windows. Operator cleanup
is bounded to 1,000 expired records and uses SKIP LOCKED. Pull updates liveness
and emits at most one metadata proof event per minute with a runtime-node actor.
It never acknowledges the outbox, creates an attempt or changes Task lifecycle.
Fresh proofs after reconnect retrieve the same command/submission/request IDs
and ciphertext until host receipt or expiry work is implemented.

## Schema and compatibility

Forward migration 0037 adds the nonce ledger and nullable original submission
actor. Legacy actors are recovered only from an exact workspace/submission queue
audit event with one unambiguous existing user; missing provenance stays withheld.
Migration 0038 adds the explicit runtime-node event actor. Apply both migrations
before serving the new endpoint. No production migration or resource mutation
was performed. Roll back application consumers without deleting durable nonce
or submission records; the added enum value need not be removed.

## Independent local evidence

| Check                                                                                      | Result                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mise exec -- bun run test:integration`                                                    | 110 passed, 1,819 assertions in 23 files; all 39 migrations applied to disposable PostgreSQL.                                                                                                                                                                                             |
| Delivery integration cases                                                                 | Ten cases cover actual Ed25519 signatures, atomic replay, immutable redelivery across a new DB connection, expired/foreign proof, durable rate history after lock waits, bounded cleanup, exact legacy audit recovery, submitter/profile/Task revocation, key rotation and node liveness. |
| Compiled production Worker and headless browser fixture                                    | Signed no-user-session HTTP delivery, replay 409, fresh-proof redelivery, invalid/foreign key refusal, extra plaintext field refusal, private/no-store and no session cookie passed. All 44 desktop/mobile cases and restricted entry/guest API checks passed.                            |
| Shared proof, bounded HTTP input, client and documentation tests                           | Eight passed, 45 assertions.                                                                                                                                                                                                                                                              |
| `mise exec -- bun run test`                                                                | 30 workspace tasks passed; the root suite passed 296 cases and 7,065 assertions.                                                                                                                                                                                                          |
| `mise exec -- bun run lint`, `typecheck`, `build`                                          | Passed: 17 lint tasks, 31 type-check tasks and 15 build tasks; 99 rendered shared UI modules checked against 182 Tailwind sources.                                                                                                                                                        |
| `mise exec -- bun run --cwd apps/web start:check-bundle`                                   | Passed with unchanged caps: Chat 304,083 raw / 101,040 gzip bytes; total client 2,964,974 bytes.                                                                                                                                                                                          |
| Compiled client under Node ESM                                                             | Native Request confirmed credentials omitted, redirects refused and no Authorization or Cookie header.                                                                                                                                                                                    |
| `mise exec -- bun run format:check`, `test:security`, `bun run --cwd packages/db db:check` | Passed: 1,787 formatted files; 31 security boundary cases / 206 assertions; migration metadata check.                                                                                                                                                                                     |
| `npx code-foundry doctor`                                                                  | Passed with the repository's existing mise toolchain.                                                                                                                                                                                                                                     |

Earlier failing cases exposed JSONB key-order comparison, premature rate-record
expiry, backdated rate accounting after lock waits, and missing node liveness. Each failed before its correction and passed
in the final integration suite. Synthetic registration records use genuine keys
and production encryption/delivery code; they do not certify deployed host setup.
The independent Worker fixture uses disposable databases and nonextractable
signing keys. Its node browser cases exercise real registration/proof APIs.
Task-owned test processes, Worker listeners and database containers are removed
and checked independently before handoff.

## Remaining acceptance

Durable host inbox and duplicate-effect fencing, decrypt/local content policy,
fresh public SDK profile/capability authorization, immutable ExecutionPlan/Skill
provenance, acceptance receipts, timeout reconciliation, result delivery and
ciphertext expiry cleanup remain. Direct Local IPC, standalone Self-hosted
operation, Railway relay deployment and packaged desktop/owner journeys still
need their own evidence. No original acceptance criterion or source checkbox
is marked verified by this increment. The #193 synchronization scope decision
continues to apply independently.
