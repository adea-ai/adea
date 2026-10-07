# M11 explicit Agent profile pin adoption

Recorded 2026-10-07 against the pinned public SDK 1.11.0/contracts 1.14.0,
on the merged SDK/discovery foundation and shared UI 0.117.0.

Public Agent creation and profile changes accept exact `prf_`/`pfv_` references.
The production SDK inspects catalog ownership/lifecycle and resolves the same
immutable version with `catalog:read` and `profile:resolve` credentials before
persistence. Draft, deprecated, superseded, revoked, missing, unapproved and
mismatched resolutions fail closed; no profile definition is persisted or
returned by the adoption helper. Callers cannot assert profile availability.

Profile changes require the opening `expectedRevision`. The database rechecks
owner/admin membership and the active workspace through commit, locks the Agent,
and atomically changes its reference/revision with a schema-version-2 event
containing previous/new references. Concurrent edits conflict. The form retains
its opening Agent snapshot through refetches; upgrading or rolling back preserves
the Agent identity. Migration `0035_agent-profile-revisions.sql` adds only the
counter and nonnegative constraint after the already merged runtime-node migration.

| Validation                                                                                              | Result                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mise exec -- bun test apps/web/test/agent-profile-pin.test.ts apps/web/test/control-plane-sdk.test.ts` | 14 passed, 81 assertions, using the actual pinned SDK and deterministic synthetic credentials. Tests cover exact scopes/reference/digest/revision matching, lifecycle/approval refusals, tenant authorization, stale edits, sanitized errors and no persistence on refusal.                                                     |
| `mise exec -- bun run test:integration`                                                                 | 85 passed, 1,717 assertions against an isolated PostgreSQL project with all 36 migrations. Upgrade/rollback, member denial, competing edits, revision fencing and transaction rollback/audit cases passed.                                                                                                                      |
| `mise exec -- bun run --cwd packages/db db:check`                                                       | Passed.                                                                                                                                                                                                                                                                                                                         |
| `mise exec -- bun run test`                                                                             | All workspace tasks and root coverage passed: root 296 tests, 7,016 assertions. Later UI bundle refinements were followed by the affected complete web/UI suites below.                                                                                                                                                         |
| `mise exec -- bun run --cwd apps/web test`                                                              | 298 passed, 1,287 assertions.                                                                                                                                                                                                                                                                                                   |
| `mise exec -- bun run --cwd packages/workspace-ui test`                                                 | 152 passed, 501 assertions.                                                                                                                                                                                                                                                                                                     |
| `mise exec -- bun run typecheck`                                                                        | All 30 tasks passed.                                                                                                                                                                                                                                                                                                            |
| `mise exec -- bun run lint`                                                                             | All 17 tasks passed, zero warnings/errors.                                                                                                                                                                                                                                                                                      |
| `mise exec -- bun run format:check`                                                                     | Passed after formatting the generated migration metadata and plan.                                                                                                                                                                                                                                                              |
| `mise exec -- bun run build`                                                                            | All 15 tasks passed; the fresh production web build verified 99 rendered shared UI modules against 182 Tailwind sources.                                                                                                                                                                                                        |
| `mise exec -- bun run --cwd apps/web start:check-bundle`                                                | Passed: 157 chunks, 2,959,082 raw bytes; Chat 301,805 raw / 100,287 gzip bytes. Existing budgets are unchanged.                                                                                                                                                                                                                 |
| `mise exec -- bun run --cwd apps/web start:test:local`                                                  | Resource-recording wrapper passed 44 headless desktop/mobile production Worker cases, including actual create-route refusal for fabricated state/latest aliases, unavailable signing configuration, foreign workspace and unchanged Agent count. Restricted entry/API checks passed.                                            |
| Headless conventional-workspace profile journey against that built Worker                               | Passed on Darwin: customization/audit request carries the opening revision; conflict guidance never displays the provider canary. Full-length public profile/version IDs at 320/768/1024/1440 pixels in light/dark preserve keyboard focus and avoid horizontal overflow. Only the affected Agent customization golden changes. |

Earlier bundle candidates exceeded Chat/total/chunk budgets. Fresh main and
candidate builds isolated the added graph cost; sharing the version fields and
keeping remediation compact passed every original gate. A cached-output restore
also left stale chunks, so comparison evidence uses fresh builds.

## Remaining acceptance

This is a bounded #41 increment. Submission-time profile pin snapshots,
concurrent change-versus-submission, immutable ExecutionPlan/Skill manifest
provenance and authoritative read-time lifecycle/remediation remain required.
The form's mutation remediation does not certify an existing Agent's current
compatibility or an execution's binding. No issue or milestone is closed.

The Worker fixture deliberately has no live Control Plane or service signer.
Successful adoption uses deterministic responses through the production SDK;
actual deployed Control Plane approval and release-candidate journeys remain
separate #42/#130 gates. Linux visual baselines/CI and manual assistive-technology
acceptance are not established by Darwin screenshots or keyboard checks. No
production migration, deployment, resource provisioning or secret change was
performed for this increment.
