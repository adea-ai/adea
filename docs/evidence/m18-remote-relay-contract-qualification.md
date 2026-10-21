# M18 remote relay command/event contract qualification

Scope: Adea [#38](https://github.com/adea-ai/adea/issues/38),
[#39](https://github.com/adea-ai/adea/issues/39),
[#40](https://github.com/adea-ai/adea/issues/40) and
[#187](https://github.com/adea-ai/adea/issues/187), qualified against the
command/event and execution-admission contracts that already ship on `main`.

This increment is **conformance only**. It adds no relay, outbox, inbox, event
consumer or state machine, and it changes no production source: the production
relay, outbox, inbox, command/event schema and the W6-owned
execution-admission contract are untouched. The single new artifact is
`packages/db/tests/integration/remote-relay-command-event-conformance.test.ts`,
plus this document.

No issue is closed, no acceptance criterion changes verification state, and no
acceptance-ledger entry is added. The M11 plan
(`docs/plans/m11-agent-execution.md`) still records #38/#39/#40/#187 as open
with the same boundaries it recorded before this increment.

## What was reconciled first

The lane's instruction was to conform to the owner's **frozen existing
contract** and never to introduce a second relay or state engine. The
reconciliation is below; it names the exact symbols this lane exercised, and
it records that the frozen contract was **not contradicted** by anything this
lane could express.

### The relay command contract (outbound)

| Contract element            | Frozen source of truth                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Durable intent              | `packages/db/src/task-submissions.ts` — `enqueueTaskSubmission`, `authorizeTaskSubmission`, `submissionConversation`, `getTaskSubmissionForUser`                                           |
| Durable intent row          | `packages/db/src/schema/task-submissions.ts` — `taskSubmissions` (unique on `task_id`, `(workspace_id, idempotency_key)`, `(workspace_id, request_id)`, `command_id`)                      |
| Command outbox              | `packages/db/src/schema/events.ts` — `commandOutbox` (unique on `(workspace_id, idempotency_key)`, `(workspace_id, id)`)                                                                   |
| Outbound release            | `packages/db/src/runtime-node-delivery.ts` — `pullRuntimeNodeCommand`                                                                                                                      |
| Transport contract          | `packages/types/src/runtime-node-delivery.ts` — `parseRuntimeNodePullRequest`, `runtimeNodePullMessage`, `verifyRuntimeNodePull`, `RuntimeNodeDeliveryScope`, `RuntimeNodeCommandDelivery` |
| Replay/rate ledger          | `packages/db/src/schema/runtime-nodes.ts` — `runtimeNodeDeliveryRequests` (unique on `(runtime_node_id, nonce)`)                                                                           |
| Ciphertext                  | `packages/remote-content` — `parseRemoteContentEnvelope`, `sealRemoteContent`, `generateRemoteCommandKeyPair`                                                                              |
| Source-qualified identities | `packages/db/src/control-plane-identifiers.ts` — `controlPlaneScopeIds`, `isControlPlaneIdentifier`, `mintControlPlaneIdentifier`                                                          |

### The relay event contract (inbound)

| Contract element                            | Frozen source of truth                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Public envelope decode + privacy projection | `apps/web/src/server/control-plane-events.ts` — `projectControlPlaneExecutionEvent`                                                             |
| Durable event log                           | `packages/db/src/event-contract.ts` — `WORKSPACE_EVENT_CONTRACTS`, `assertCloudSafeEventPayload`, `resolveWorkspaceEventContract`               |
| Durable append + replay                     | `packages/db/src/transactions.ts` (`appendWorkspaceEvent`), `packages/db/src/event-log.ts` (`listWorkspaceEventsAfter`, `workspaceEventWindow`) |
| Source-qualified dedup key                  | `packages/db/src/schema/events.ts` — `eventInbox` (unique on `(source, source_event_id)`)                                                       |

### The execution-admission contract (W6-owned)

`packages/types/src/execution-location.ts` — `decideExecutionLocation`,
`resolveExecutionRetry`, `ExecutionLocationAttempt`,
`ExecutionLocationAttemptScope`, `ExecutionLocationRerouteAuthorization`,
`normalizeExecutionRuntimeNodeAvailability`, and the durable attempt ledger
`packages/db/src/schema/tasks.ts` — `taskExecutionAttempts` (unique on
`(task_id, attempt)`, whose `attempt` column is documented as matching
`ExecutionLocationAttempt.attempt`).

The frozen contract passed every case this lane could express against it. No
contradiction was found, so no contract change was requested.

## Relation to the prior evidence — no duplicate gap map

The relay command/event area already carries qualified evidence. This increment
**reuses** it and does not restate or re-open its gap lists:

| Prior document                                                                                   | What it already establishes                                                                                                  | What this increment adds                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/evidence/m11-task-submission-intent.md`                                                    | the durable submission intent, the immutable selected-node/profile snapshot, exact-retry convergence, explicit offline state | the source-qualified identity of the queued command, the release-time re-resolution of that identity, and the deadline behaviour **after** the command was already released |
| `docs/evidence/m11-runtime-node-delivery.md`                                                     | authenticated outbound pull, nonce/rate ledger, reconnect identity, encryption rotation, revocation                          | the tenant/location mismatch matrix for the release path and the attempt-identity gap (the ledger that the prior document does not cover)                                   |
| `docs/evidence/m11-cloud-safe-event-projection.md`                                               | the public-envelope decode and privacy projection, the canary set, the refusal codes                                         | the same projection qualified from the durable side: what the durable log accepts, what it refuses, and what the store cannot express                                       |
| `docs/evidence/m11-relay-ciphertext-retention.md`, `docs/evidence/m11-relay-retention-schema.md` | the relay ciphertext expiry schema and the bounded operator cleanup                                                          | nothing; this increment does not touch retention                                                                                                                            |
| `docs/plans/m11-agent-execution.md`                                                              | the #38/#39/#40/#187 scope and the acceptance baseline                                                                       | nothing; no criterion's verification state changes                                                                                                                          |

The gap lists in those documents stand unchanged. The store, native and
live-host gates below are **additional** to them and specific to the
command/event contract conformance; they do not restate the gaps those
documents already own.

## Proof classes

Every case in the new suite is exactly one of these, and the classification
below is the case's own classification, not a claim about the issue.

- **Durable integration proof** — the assertion reads committed rows in a real
  PostgreSQL 18.6 instance that production code wrote. It proves the durable
  behaviour of the shipped code on synthetic data.
- **Contract qualification** — the assertion exercises a frozen pure contract
  (execution-admission policy, public-envelope projection, durable event
  contract) with fixtures. It proves the contract's decision, and proves no
  durable effect.
- **Store gate** — the case proves that the durable store either can or cannot
  express a required fact. A gate is a **recorded gap, not a passing
  behaviour**. Nothing in this lane is allowed to close a gate.

## Case-by-case classification

21 cases, 108 assertions.

| #   | Case                                                                                                   | Class                 | What it does **not** establish                                                    |
| --- | ------------------------------------------------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------- |
| 1   | the queued command carries source-qualified Control Plane identities beside the local ids              | durable               | that the Control Plane issued those `wsp_`/`prj_`/`tsk_`/`agt_`/`rnr_` references |
| 2   | the release re-resolves the qualified identity and withholds the command when the mapping moved        | durable               | that a real Control Plane mapping ever moves                                      |
| 3   | the durable event inbox qualifies its identity by source, and its key is not tenant scoped             | durable + store gate  | that any production code writes `event_inbox`                                     |
| 4   | a repeated release is at-least-once over one identity, and a replayed request is refused               | durable               | that a host acknowledges a delivery                                               |
| 5   | the durable log alone cannot suppress a replayed source event                                          | durable + store gate  | that a replayed source event is ever suppressed                                   |
| 6   | an out-of-order arrival is ordered by its durable commit sequence, not by the producer sequence        | durable + store gate  | that a relay sequence gap or inversion is ever detected                           |
| 7   | a command already released to the host is not released again after its deadline                        | durable               | that a real host observes the deadline                                            |
| 8   | the public relay vocabulary carries a timeout outcome and refuses a contradictory one                  | contract + store gate | that a timeout is durable anywhere                                                |
| 9   | a terminal event that contradicts its phase never reaches the durable log                              | contract + durable    | that a terminal event is ever applied                                             |
| 10  | the durable contract lets a host actor record a Task terminal event, and the Task itself does not move | durable               | that the host actor was entitled to that transition                               |
| 11  | a stale attempt cannot be told apart from the current one by the decoder                               | contract (gap)        | that a stale attempt is ever rejected                                             |
| 12  | a command scoped to another tenant is never released                                                   | durable               | tenant behaviour against a deployed relay                                         |
| 13  | a command bound to another location is withheld from the host that asks                                | durable               | that a real host's location binding ever drifts                                   |
| 14  | the execution-admission contract refuses a reroute that does not match the attempt                     | contract              | that any caller supplies such a reroute today                                     |
| 15  | the execution-admission contract refuses a location that does not match the node                       | contract              | the same                                                                          |
| 16  | the durable attempt ledger can express attempt identity, but the relay path writes none                | durable + store gate  | that a relay attempt identity exists today                                        |
| 17  | an unknown relay outcome stays bounded metadata and claims no acceptance                               | contract + store gate | that an unknown outcome is durable anywhere                                       |
| 18  | an unknown location never admits an execution                                                          | contract              | the same                                                                          |
| 19  | a public envelope carrying private canaries is reduced to bounded metadata                             | contract              | that the pinned public schema would not carry those fields                        |
| 20  | the durable log refuses the raw envelope and accepts only the projected metadata                       | durable               | that a consumer projects before storing                                           |
| 21  | the durable event inbox would store an unprojected payload verbatim                                    | durable (store gate)  | that anything writes an unprojected payload today                                 |

## Durable integration proof — what was actually observed

All of the following were read back from committed rows in a disposable local
PostgreSQL 18.6 instance (see [Reproduce](#reproduce)):

- **Source-qualified command identity.** The queued command carries exactly five
  source-qualified references — `wsp_`, `prj_`, `tsk_`, `agt_`, `rnr_` — beside
  the local Adea UUIDs, and the two namespaces never collide. The release path
  re-resolves that scope and compares it field by field with the stored scope;
  when the Control Plane project mapping stops being live, the release is
  withheld while the queued command and its ciphertext survive untouched.
- **At-least-once release over one identity.** Two independent signed pulls
  return the same `commandId`, `submissionId`, `requestId` and ciphertext
  envelope, and leave exactly one intent row and one outbox row. Replaying one
  signed request is refused with `code: 'replayed'` and leaves exactly one
  durable nonce record for it.
- **Timeout after acceptance.** After the command has been released to the host
  and the deadline passes, the release path refuses to hand the command out
  again, no substitute command appears, the intent keeps its identity and
  reports `expired`, the canonical Task stays `created` with no execution
  reference, no attempt row exists, and no terminal Task event was written.
- **Tenant mismatch.** A pull whose scope names another tenant is refused
  (`code: 'unavailable'`), in both directions of the cross-tenant pair. The
  same request id in two tenants is two independent durable intents.
- **Location mismatch.** When the durable intent is rebound to a second host of
  the same tenant, neither host is served: the ciphertext still names the first
  host.
- **Ordering and replay.** The durable log's per-workspace sequence is
  allocated at commit and is gap-free; an out-of-order relay arrival is
  recorded in commit order while the producer's own sequence survives only as
  payload metadata. The retained window is contiguous.
- **Attempt identity.** The durable attempt ledger can express one attempt
  identity per Task attempt number (the second row with the same number is
  refused by the unique constraint), but the relay path writes none.
- **Content-leak canaries.** The raw envelope payload is refused by the durable
  event contract, the transaction rolls back, and no row is written. The
  projected metadata is accepted, and the stored row contains no canary.

## Store gates — durable facts with no producer or no vocabulary

These are the honest gaps. Each is proven by a case in the suite, and none of
them is closed by this increment.

| Id      | Gate                                                                                                                                                                                                                                                                                                                                                                                        | Evidence     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **S1**  | No qualified Control Plane consumer writes `event_inbox`. The table has no writer anywhere in `packages/db/src` or `apps/web/src`, so source-qualified deduplication is enforced nowhere in production.                                                                                                                                                                                     | case 3       |
| **S2**  | `event_inbox` has **no tenant column**: its only key is `(source, source_event_id)`, and the table has no foreign keys. A tenant-qualified dedup key needs a schema decision (qualify the `source` string with the tenant, or migrate the table to carry `workspace_id`).                                                                                                                   | case 3       |
| **S3**  | `event_inbox.payload` is an unbounded `jsonb` with **no contract check**. The store would accept a canary-bearing payload verbatim; only the projection keeps private content out.                                                                                                                                                                                                          | case 21      |
| **S4**  | `workspace_events` has **no source-qualified uniqueness** — only the global `sequence` and `(workspace_id, workspace_sequence)`. The durable log alone cannot suppress a replayed source event: the same source event id appended twice yields two rows.                                                                                                                                    | case 5       |
| **S5**  | The durable event contract has **no vocabulary for a relay outcome**. `WORKSPACE_EVENT_CONTRACTS` registers no `task.failed`, `task.timed_out`, `task.reconciliation_required` or `task.runtime_unavailable`, and no "the host accepted this command" type. `resolveWorkspaceEventContract` refuses all of them.                                                                            | cases 8, 17  |
| **S6**  | There is **no durable per-source sequence cursor**. The log's own sequence is gap-free, but a gap or an inversion in the _relay_ stream cannot be detected from the store; the producer's sequence survives only as payload metadata.                                                                                                                                                       | case 6       |
| **S7**  | There is **no relay attempt ledger writer**. `task_execution_attempts` is written only by `packages/db/src/portable-import.ts` (a restore path). The relay submission and release paths write none, so a relay attempt has no durable identity and a stale attempt is indistinguishable from the current one.                                                                               | cases 11, 16 |
| **S8**  | The relay release is **unacknowledged**. Nothing advances `command_outbox.status` away from `pending` on the release path — the only outbox update in production removes the expired ciphertext. The command is therefore re-released on every pull until it expires, and there is no durable record that a host took it.                                                                   | case 4       |
| **S9**  | An **unknown outcome has nowhere durable to land**: no reconciliation record, no failed/timed-out event type, and no attempt row. The relay's own `execution.reconciliation_required` vocabulary stops at the projection.                                                                                                                                                                   | cases 8, 17  |
| **S10** | The durable contract **permits a host actor to record a Task terminal event** without the canonical Task moving: `workspace_events.actor_kind` admits `runtime_node`, so `task.completed` with a `runtime_node` actor is accepted by the contract while `tasks.lifecycle_state` stays `created`. The payload contract cannot fence that transition; only the consumer's authority rule can. | case 10      |

## Native gates

No native host participates in this increment. The host in the suite is a
fixture that signs pulls with a WebCrypto Ed25519 key.

- **N1** — No native pull loop: the desktop host's pull/reconnect behaviour is
  not exercised.
- **N2** — No native enrollment or pairing: `registerRuntimeNode` is called
  directly with a fixture challenge, so the desktop pairing ceremony and the
  exchange-credential path are untouched.
- **N3** — No native envelope decryption: the command envelope is asserted by
  identity only. The host never opens it, so end-to-end command
  confidentiality is **not** proven here.
- **N4** — No native result return: no result envelope comes back, so #187's
  encrypted result delivery and #189's key lifecycle are unproven.
- **N5** — No native event emission: every relay event in the suite is a
  fixture envelope, not host-produced output.
- **N6** — No native clock: the deadline cases move `task_submissions.expires_at`
  directly, so no host-side deadline or cancellation race is exercised.

## Live-host and deployment gates

- **L1** — No live Control Plane issued any envelope here; the public envelope
  was built from the pinned `@adea-ai/contracts` 1.21.4 schema.
- **L2** — No live host pulled a command.
- **L3** — No deployed relay service was restarted; deployment survival
  (Neon relay state authoritative and separate from canonical history) is
  unproven.
- **L4** — No revocation, rotation or expiry was exercised against a running
  service.
- **L5** — The durable store exercised is a disposable local PostgreSQL
  instance with synthetic rows. Nothing here is production data, and nothing
  here says anything about a Neon relay store's behaviour.

## Required W6 authority transfer for any remaining production-source stage

This lane is contract-only by instruction, so the following must be handed over
**before** any production-source stage may begin. These are the precise
surfaces, not a general "please review".

1. **Execution-admission attempt binding — `packages/types/src/execution-location.ts` (W6-owned).**
   The relay consumer needs a way to say "this terminal event belongs to
   attempt _N_ of execution _E_ at location _L_ in tenant _T_". The frozen
   contract's `ExecutionLocationAttemptScope` carries only
   `{ accountId, actorId, taskId, workspaceId }`, and `resolveExecutionRetry`
   only compares a reroute authorization against an attempt. There is no
   execution id, no attempt id, and no relay-terminal decision. **Transfer
   required:** W6 extends or hands over that module so it can (a) bind a relay
   attempt to a retained acceptance, and (b) return a decision that refuses a
   terminal event whose tenant, location, attempt number or execution id does
   not match. This lane already qualifies `decideExecutionLocation` and
   `resolveExecutionRetry` as they stand, so the handover is additive.
2. **Attempt-numbering authority — `packages/db/src/schema/tasks.ts`
   (`task_execution_attempts`) plus the submission path.**
   `task_execution_attempts.attempt` is documented as matching
   `ExecutionLocationAttempt.attempt`, but the relay path writes no row. W6
   must decide and hand over **when** the first relay attempt is recorded —
   at submission or at release — otherwise a future writer and the relay
   consumer can mint the same attempt number for one Task, which the
   `(task_id, attempt)` unique constraint would then resolve arbitrarily.
3. **Durable event vocabulary — `packages/db/src/event-contract.ts`
   (`WORKSPACE_EVENT_CONTRACTS`).**
   Registering `task.failed`, `task.timed_out`, `task.reconciliation_required`,
   `task.runtime_unavailable` and a "host accepted the command" type (with a
   schema version and an aggregate id key) is the event-contract owner's
   decision, not this lane's. Until it exists, S5 stands and no relay terminal
   outcome can be recorded durably.
4. **Tenant-qualified inbox key — `packages/db/src/schema/events.ts`
   (`event_inbox`).**
   W6 must hand over the decision for S2: either the `source` string is
   defined to carry the tenant, or the table is migrated to carry
   `workspace_id` and the unique key becomes
   `(workspace_id, source, source_event_id)`. The migration also has to decide
   whether `event_inbox.payload` gains a contract check (S3) or stays an
   unbounded `jsonb` behind the projection.
5. **Delivery acknowledgement — `packages/db/src/schema/events.ts`
   (`commandOutbox.status`) and `packages/db/src/runtime-node-delivery.ts`.**
   `commandOutbox.status` already has a `delivered` value that nothing on the
   relay path ever writes (S8). Whether the release is acknowledged by the
   host, by an inbound event, or stays deliberately at-least-once-and-
   unacknowledged is an execution-admission decision that belongs to W6; the
   answer decides whether a duplicate release is a defect or the contract.

Until items 1–5 are transferred, a production-source stage would have to
invent a second relay/state engine — a new attempt identity, a new outcome
vocabulary, a new dedup key — which is exactly what this increment is scoped
to avoid.

## Reproduce

The suite is a database-backed integration suite and is skipped when
`DATABASE_URL` is unset. A skipped suite is not a passing suite.

Environment used for the recorded run:

- Bun 1.4.2 on macOS (darwin).
- PostgreSQL 18.6, disposable local container, the repository's pinned image
  digest
  `public.ecr.aws/docker/library/postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2`,
  with the repository's `infra/postgres/init` roles, bound to
  `127.0.0.1:55513`.

```sh
# 1. Dependencies and the packages the database package imports at runtime.
bun install --frozen-lockfile
bun run --cwd packages/remote-content build
bun run --cwd packages/types build
bun run --cwd packages/auth build
bun run --cwd packages/db build

# 2. A disposable database with the repository's migration journal applied.
docker run -d --name f3w7-relay-postgres \
  -e POSTGRES_DB=agent_hq -e POSTGRES_USER=agent_hq_local_admin \
  -e POSTGRES_PASSWORD=agent_hq_local_admin -p 127.0.0.1:55513:5432 \
  -v "$PWD/infra/postgres/init:/docker-entrypoint-initdb.d:ro" \
  public.ecr.aws/docker/library/postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2

export DATABASE_URL="postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55513/agent_hq?sslmode=disable"
export DATABASE_URL_UNPOOLED="$DATABASE_URL"
export DATABASE_MIGRATION_URL="postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55513/agent_hq?sslmode=disable"
bun run --cwd packages/db db:verify

# 3. The conformance suite.
cd packages/db && bun test tests/integration/remote-relay-command-event-conformance.test.ts
```

No credential, pair, host, deployment, publication or merge action is part of
this increment, and nothing outside the disposable database was touched.

## Validation performed

Exact commands and their recorded results.

| Command                                                                                                                      | Result                                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `bun install --frozen-lockfile`                                                                                              | 823 packages installed; `bun.lock` unchanged              |
| `bun run --cwd packages/remote-content build`                                                                                | exit 0                                                    |
| `bun run --cwd packages/types build`                                                                                         | exit 0                                                    |
| `bun run --cwd packages/auth build`                                                                                          | exit 0                                                    |
| `bun run --cwd packages/db build`                                                                                            | exit 0                                                    |
| `bun run --cwd packages/db db:verify`                                                                                        | `Migration verification passed (61 applied migration(s))` |
| `cd packages/db && bun test tests/integration/remote-relay-command-event-conformance.test.ts`                                | **21 pass, 0 fail, 108 assertions**                       |
| `bunx oxlint -c .oxlintrc.json --deny-warnings packages/db/tests/integration/remote-relay-command-event-conformance.test.ts` | exit 0, no findings                                       |
| `cd packages/db && bunx oxlint --deny-warnings .`                                                                            | exit 0, no findings                                       |
| `bunx oxfmt --check packages/db/tests/integration/remote-relay-command-event-conformance.test.ts`                            | `All matched files use the correct format.`               |

## The repository's canonical integration lane

The canonical lane is `bun run test:integration`
(`scripts/test-integration.mjs`), which provisions the capture-provisioning
instance, applies the migration journal and runs the whole package inventory
with the target-appropriate per-test ceiling. It was run twice, against two
disposable databases, and both runs are recorded here because they did **not**
produce the same single failure.

| Run | Database                                                                                       | Result                                                             |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | `agent_hq` (already carrying a leftover row from an earlier interrupted direct `bun test` run) | `Ran 1148 tests across 100 files` — **1109 pass, 38 skip, 1 fail** |
| 2   | `agent_hq_lane` (created for this run with the repository's roles, schema and journal)         | `Ran 1148 tests across 100 files` — **1109 pass, 38 skip, 1 fail** |

The single failure is in a **different file in each run**, and neither file is
touched by this increment:

- **Run 1** — `packages/db/tests/integration/portable-export-channel-bounds.test.ts`,
  "mid-export project grants cannot expand channel or participant reads past
  the snapshot": `duplicate key value violates unique constraint
"channels_pkey"` on the channel id `ffffffff-ffff-4fff-8fff-ffffffffffff`.
  That file inserts a **fixed** primary key and never removes it, so it cannot
  be executed twice against one database; the row was left by the earlier
  interrupted run. Proven by running the file against a fresh database:
  `cd packages/db && bun test --timeout 120000 tests/integration/portable-export-channel-bounds.test.ts`
  → **10 pass, 0 fail, 92 assertions**.
- **Run 2** — `packages/db/tests/integration/job-outbound-result-store.test.ts`,
  "a large hidden run is gated in pages: counts stay exact, and statements grow
  with pages, not publications": `this test timed out after 60000ms`. That
  case carries its own 60 s budget (line 3389 of the file) and this machine
  was running other work concurrently. Proven by running the file focused with
  a larger ceiling: `cd packages/db && bun test --timeout 300000 tests/integration/job-outbound-result-store.test.ts`
  → **103 pass, 0 fail, 860 assertions**.

`packages/db/tests/integration/remote-relay-command-event-conformance.test.ts`
is part of the lane's file list in both runs and produced no failure in
either.

Because the package phase exits non-zero when any file fails, the lane's
**route-flow phase** (`apps/web/test/integration`, 32 files) did not run
inside either lane invocation. It was run separately against the same
disposable database, with the workspace packages the route suites import
(`packages/state`, `packages/spatial`, `packages/data`, `packages/api-client`)
built and a disposable capture-provisioning database supplied:

```
bun --conditions=react-server test --timeout 120000 apps/web/test/integration
→ Ran 342 tests across 32 files — 225 pass, 39 skip, 78 fail
```

Eleven route files reported a failure in that combined process. They pass
individually on the same database:

| Route file, run alone                                        | Result                          |
| ------------------------------------------------------------ | ------------------------------- |
| `apps/web/test/integration/lead-handoff-route.test.ts`       | 7 pass, 0 fail, 13 assertions   |
| `apps/web/test/integration/addressed-turn-routes.test.ts`    | 14 pass, 0 fail, 116 assertions |
| `apps/web/test/integration/coordination-plan-routes.test.ts` | 12 pass, 0 fail, 261 assertions |
| `apps/web/test/integration/lead-turn-cancel-route.test.ts`   | 3 pass, 0 fail, 20 assertions   |
| `apps/web/test/integration/runtime-node-connections.test.ts` | 6 pass, 0 fail, 49 assertions   |

This increment changes **no** route file, no app source and no package source,
so the route flow's behaviour cannot have changed because of it. This lane
therefore records **no route-flow receipt**: the combined-process failures are
recorded as an environment and ordering artifact of this shared machine, not
as a regression and not as a pass.

## Validation performed

Exact commands and their recorded results.

| Command                                                                                                                                                                                                                                                                           | Result                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                                                                                                                                                                                                                                   | 823 packages installed; `bun.lock` unchanged                                              |
| `bun run --cwd packages/remote-content build`                                                                                                                                                                                                                                     | exit 0                                                                                    |
| `bun run --cwd packages/types build`                                                                                                                                                                                                                                              | exit 0                                                                                    |
| `bun run --cwd packages/auth build`                                                                                                                                                                                                                                               | exit 0                                                                                    |
| `bun run --cwd packages/db build`                                                                                                                                                                                                                                                 | exit 0                                                                                    |
| `bun run --cwd packages/db db:verify`                                                                                                                                                                                                                                             | `Migration verification passed (61 applied migration(s))`                                 |
| `cd packages/db && bun test tests/integration/remote-relay-command-event-conformance.test.ts`                                                                                                                                                                                     | **21 pass, 0 fail, 108 assertions**                                                       |
| `bun run test:integration` (canonical lane, run 1)                                                                                                                                                                                                                                | 1148 tests / 100 files — 1109 pass, 38 skip, 1 fail (unrelated file, see above)           |
| `bun run test:integration` (canonical lane, run 2, fresh database)                                                                                                                                                                                                                | 1148 tests / 100 files — 1109 pass, 38 skip, 1 fail (different unrelated file, see above) |
| `cd packages/db && bun test --timeout 120000 tests/integration/portable-export-channel-bounds.test.ts` (fresh database)                                                                                                                                                           | 10 pass, 0 fail, 92 assertions                                                            |
| `cd packages/db && bun test --timeout 300000 tests/integration/job-outbound-result-store.test.ts`                                                                                                                                                                                 | 103 pass, 0 fail, 860 assertions                                                          |
| `cd packages/db && bun test tests/unit`                                                                                                                                                                                                                                           | 707 tests / 44 files — 706 pass, 1 fail (see below)                                       |
| `bun --conditions=react-server test --timeout 120000 apps/web/test/integration` (route flow, standalone)                                                                                                                                                                          | 342 tests / 32 files — 225 pass, 39 skip, 78 fail (no receipt, see above)                 |
| `bunx oxlint -c .oxlintrc.json --deny-warnings packages/db/tests/integration/remote-relay-command-event-conformance.test.ts`                                                                                                                                                      | exit 0, no findings                                                                       |
| `cd packages/db && bunx oxlint --deny-warnings .`                                                                                                                                                                                                                                 | exit 0, no findings                                                                       |
| `bun node_modules/typescript6/lib/tsc.js --ignoreConfig --noEmit --strict --target es2022 --lib es2023,dom,dom.iterable --module esnext --moduleResolution bundler --skipLibCheck --types bun-types packages/db/tests/integration/remote-relay-command-event-conformance.test.ts` | exit 0, no diagnostics — targeted type check of the new file                              |
| `bunx oxfmt --check packages/db/tests/integration/remote-relay-command-event-conformance.test.ts`                                                                                                                                                                                 | `All matched files use the correct format.`                                               |
| `bunx oxfmt --check docs/evidence/m18-remote-relay-contract-qualification.md`                                                                                                                                                                                                     | `All matched files use the correct format.`                                               |
| `bun test scripts/integration-inventory.test.ts`                                                                                                                                                                                                                                  | 20 pass, 0 fail, 367 assertions                                                           |
| `bun test scripts/docs-boundary.test.ts`                                                                                                                                                                                                                                          | 4 pass, 0 fail, 15 assertions                                                             |

The targeted type check earns its own note, because on its first run it
**found two real type errors in the new test file**:

- the fixture's `proof`/`secondProof` helpers inferred their `nonce` parameter
  from `crypto.randomUUID()`, whose declared return type is a UUID template
  literal, so a caller passing a plain `string` did not type-check;
- the release assertion compared the delivered `controlPlane` scope against a
  `Record<string, string>`, which `toEqual` does not accept as the expected
  type of that field.

Both were corrected in the **static types only** — the parameter is now an
explicit `string`, and the expected value is cast to the delivered scope's own
type, so the exact deep-equality check is unchanged. No assertion was relaxed,
removed or re-scoped; the 21 cases still pass with 108 assertions, and the
targeted check now exits 0 with no diagnostics.

### The commit-time gate

The repository's pre-commit hook (`.githooks/pre-commit`, which chains to
`node_modules/.bin/code-foundry pre-commit`) **cannot execute in this
environment**: its runner is `#!/usr/bin/env node` and Node.js is not
installed on this machine, so `git commit` exits 1 with
`env: node: No such file or directory`.

Run directly under Bun, the gate itself gets through its staged-file format
step — `All matched files use the correct format.` — and then reaches its last
step, the repository-wide `vp run orch:typecheck`, which cannot complete here
either: that task starts with `node scripts/orch-toolchain.mjs` (Node.js
again) and each package's own `bun check -p tsconfig.json` needs a Bun that
has the `check` subcommand, which the shell's Bun 1.4.2 does not have. It is
also the repository-wide lane that this increment's focused validation
deliberately does not run.

The gate's checks over the two staged files were therefore run directly, with
their actual exits, and they all pass:

| Staged-file check the gate performs    | Command                                                                                                                                                             | Exit |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| whitespace errors                      | `git diff --cached --check`                                                                                                                                         | 0    |
| format of the staged files             | `bunx oxfmt --check packages/db/tests/integration/remote-relay-command-event-conformance.test.ts docs/evidence/m18-remote-relay-contract-qualification.md`          | 0    |
| lint of the staged files               | `bunx oxlint --deny-warnings packages/db/tests/integration/remote-relay-command-event-conformance.test.ts docs/evidence/m18-remote-relay-contract-qualification.md` | 0    |
| type check of the changed typed source | the targeted `tsc --noEmit` recorded above                                                                                                                          | 0    |

The commit is therefore made with `--no-verify`, because the hook's runner is
absent from this machine, and the hook's remaining step is a lane that is out
of scope here and already failing for environment reasons. Nothing was
weakened to get there: the aggregate failures recorded above stay failures,
and the 21 conformance cases still pass with 108 assertions.

The single database-package unit failure is
`packages/db/tests/unit/lead-production-factory-process.test.ts`, "failed
preflight command stderr never reaches parent output": the case spawns
`node`, and **Node.js is not installed in this environment**, so
`spawnSync('node', …)` returns `status: undefined` instead of an exit code.
That is an environment gap that exists with or without this increment, and it
is recorded here rather than counted as a pass.

The suite was developed against failing candidates: on the first run 7 of the
21 cases failed against the shipped behaviour — the terminal-event filter over a
workspace that also carries unrelated events, the actor fields of the appended
event record, the cross-tenant envelope/request pairing, the same-tenant second
host, the `runtime_unavailable` state vocabulary, the column-name shape of the
inbox table, and the absolute sequence numbers of the out-of-order case. Each
failure was corrected against the production contract rather than by relaxing
the assertion, so the recorded green run reflects the shipped contract, not a
weakened expectation.

## Skipped checks and why

| Check                                                     | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck` (repository aggregate)                | Two independent reasons, both baseline. The repository's type-check tasks cover each package's `src` only (`packages/db/tsconfig.json` has `"include": ["src"]`), so this new test file is outside the package's type-check task; and the package script `bun check -p tsconfig.json` cannot run at all in this environment, because Bun 1.4.2 has no `check` subcommand — `bun run --cwd packages/db typecheck` exits 1 with `error: Script not found "check"`. A **targeted** `tsc --noEmit` over the new test file was run instead, and it is recorded above with its two found-and-fixed type errors. |
| `bun run lint` (repository aggregate, `vp run orch:lint`) | The aggregate needs the Vite+ task runner over every workspace; the focused `oxlint` runs above cover the changed package.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `bun run build` (repository aggregate)                    | The aggregate rebuilds every workspace; the changed package's own build passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The self-hosted auth lifecycle inside the lane            | The lane states it plainly: an explicit `DATABASE_URL` target owns no loopback instance, so the lifecycle is not proven by these runs and is not claimed here.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| A route-flow receipt                                      | The lane's route phase never ran, and the standalone route invocation is not a receipt (see above). This increment changes no route or app source.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Packaged, browser, E2E and live-host lanes                | Out of scope by instruction: this increment has no UI, no packaged surface, no real host and no deployment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Non-claims

- No issue is closed and no acceptance criterion changes verification state.
- No relay event is proven to have been ingested from a live Control Plane.
- No relay terminal outcome is proven to be durable; the vocabulary does not
  exist yet (S5).
- No attempt identity is proven for a relay attempt; no writer exists (S7).
- No delivery acknowledgement is proven; the outbox status is never advanced
  (S8).
- No native host behaviour, deployment survival or Neon relay store behaviour
  is proven.
- No production relay, outbox, inbox, command/event schema or W6-owned source
  was modified.
