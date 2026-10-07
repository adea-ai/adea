# M11 durable encrypted Task submission intent

Recorded 2026-10-07 against the public SDK/contracts foundations. This increment
implements the cloud producer for #38/#187. It has no execution consumer,
acceptance or milestone completion claim.

The authenticated `GET`/`POST /api/v1/workspaces/:workspaceId/tasks/:taskId/submission`
boundary accepts an exact selected RuntimeNode, Task version, immutable Agent
profile/version/revision, explicit offline policy and a bounded v1 command
envelope. The streamed body is bounded independently from Content-Length. Caller
fields cannot inject prompt/context text into the fixed relay projection.

The database transaction holds authorization, Task, Agent, node and verified key
locks through admission. It snapshots the selected location and pin, writes one
metadata intent and ciphertext outbox command, and appends one metadata event.
The origin's scoped Channel/Message and objective ContentRef identifiers remain
separate from host/runtime state. Public `agt_`/`tsk_` identifiers are stored
independently from Adea UUIDs. RuntimeNode public key views now expose the actual
key UUID for envelope addressing.

Workspace-scoped idempotency and request locks make duplicate admission converge
on one intent. Changed payloads and competing keys conflict; expired reads retain
the original identity. A foreign reference, existing execution, stale pin/version,
revoked node or unverified/retired command key refuses new admission. Node
rotation/proof/revocation lock the node first to match queue admission. A recent
proof is a liveness hint only: no runtime capability or host acceptance is inferred.

The new migration adds scoped foreign keys and immutable coordination columns.
Outbox deletion cannot cascade away the submission identity. It widens the outbox
idempotency index from global to workspace scope without changing existing records.
No production database migration or resource change was performed.

## Local evidence

| Validation                                                                                                                                       | Result                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mise exec -- bun run test:integration`                                                                                                          | 100 passed, 1,780 assertions across 22 files. All 37 migrations verified in isolated PostgreSQL. Fifteen queue cases cover concurrent retries, scope/key/profile refusal, rollback, immutable expiry identity, deletion protection and origin correlation. Admission/retention/reference regression cases failed before their fixes.                                                                                    |
| `mise exec -- bun run test`                                                                                                                      | 30 workspace tasks passed; root coverage 296 passed, 7,043 assertions after merging current main. A desktop case first timed out after five seconds while browser workers ran; it passed alone in 1.23 seconds and in this serial full run. The later refinements passed the complete integration and database unit suites; the separate API entry and status trim passed all 25 API-client and 155 workspace UI tests. |
| `mise exec -- bun run build`                                                                                                                     | All 15 tasks passed; 99 rendered shared UI modules verified against 182 Tailwind sources.                                                                                                                                                                                                                                                                                                                               |
| `mise exec -- bun run lint`, `typecheck`, `format:check`                                                                                         | Passed: 17 lint tasks, 31 type-check tasks, 1,774 formatted files. No shared lint exceptions or bundle-limit increases.                                                                                                                                                                                                                                                                                                 |
| `mise exec -- bun test apps/web/test/task-submission-request.test.ts packages/api-client/tests/unit/tasks.test.ts scripts/docs-boundary.test.ts` | Ten passed, 47 assertions. Streamed size, malformed UTF-8/JSON, exact fields and command metadata are covered.                                                                                                                                                                                                                                                                                                          |
| `mise exec -- bun run --cwd packages/db db:check`                                                                                                | Passed.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `mise exec -- bun run test:security`                                                                                                             | 31 passed, 206 assertions.                                                                                                                                                                                                                                                                                                                                                                                              |
| Compiled production Worker API and headless browser fixture                                                                                      | Final combined-candidate API checks and all 44 desktop/mobile browser cases passed. Restricted-entry and guest API checks also passed; isolated Worker and PostgreSQL resources were cleaned.                                                                                                                                                                                                                           |
| `mise exec -- bun run --cwd apps/web start:check-bundle`                                                                                         | Passed: Chat 304,083 raw / 101,036 gzip bytes, within unchanged limits. A clean current-main build also reproduced the prior 304,194-byte overage. Deduplicating Agent lifecycle checks and projecting the badge configuration preserves its labels/tooltips while restoring the budget. Submission methods have their own package entry point; its compiled Node ESM import and encoded GET request passed.            |
| `mise exec -- bun audit`                                                                                                                         | No vulnerabilities across 840 packages. The lockfile adds only an existing internal workspace dependency; no new external package/version.                                                                                                                                                                                                                                                                              |

The database cases use an isolated PostgreSQL instance, synthetic registration
records and genuine HPKE envelopes. They exercise production admission code;
synthetic verified-key records do not certify host pairing. The compiled Worker
fixture checks authentication, unauthorized scope, exact retry identity, GET/POST,
payload conflict, rejected extra plaintext fields, no-store, one ciphertext outbox,
one metadata event and no false Task/attempt transition. Its node browser suite
separately exercises real registration/proof APIs with Ed25519 fixtures.

## Remaining acceptance

Authenticated outbound node delivery, local durable inbox/decrypt, duplicate
delivery/effect fencing, fresh SDK profile/policy/capability authorization,
ExecutionPlan/Skill provenance, SDK acceptance and receipt/reconciliation remain.
The producer does not call Control Plane, decrypt or authenticate ciphertext,
create an execution attempt, change Task lifecycle, or write conversation history.
One initial intent per Task is deliberate; an explicit retry/reconciliation policy
must precede replacement attempts. Expiry ciphertext cleanup and queued key grace
remain required; expiry is currently a read projection, not a purge worker.

Direct Local IPC, product submission controls, event projection, cancellation,
approval/input/resume, standalone host setup and connected certification remain
owned by the milestone's separate criteria. No original criterion or source
checkbox is marked verified by this increment. Cross-device history/key/device
synchronization retains the explicit #193 scope disposition.
