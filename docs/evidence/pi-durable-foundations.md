# Workspace lead and direct-topic foundations

This additive slice implements the isolated-topic contracts of
[F2 (#1171)](https://github.com/adea-ai/adea/issues/1171) and the structural lead API portion of
[F1 (#1170)](https://github.com/adea-ai/adea/issues/1170). F2's local acceptance checks and independent source review are recorded below;
hosted exact-head checks and merge review remain required. F1's automatic Home
and optional-workspace provisioning remains separate. This slice does not qualify a running
Pi lead, a provider connection, or a lead-to-child journey.

## Identity and setup

Migration 0042 adds `agents.is_workspace_lead`, defaulting every existing Agent to false.
A partial unique index allows one designation per workspace, including configuration-error
Agents. A designated lead cannot be archived or placed under a project. Stable Adea and
Control Plane IDs and all existing Agent rows remain intact.

`POST /api/v1/workspaces/:workspaceId/agents/lead` accepts `{}` and idempotently provisions
the structural lead for an owner or admin. Concurrent setup serializes on the workspace.
`GET` returns `{ lead: AgentSummary | null }` only to a member of a live workspace. Neither
operation calls a model, copies credentials, chooses a provider, or creates a session.
The structural profile sentinel is explicitly missing until an exact eligible profile is
adopted through the existing revision-checked profile flow. Profile availability reads preserve
that setup state without a catalog call. A lead designation is never proof of model readiness.

Automatic integration with Home and optional-workspace creation remains a follow-up after
the canonical workspace changes; this slice does not change workspace creation or deletion.

## Topics and audience

`POST /api/v1/workspaces/:workspaceId/channels` with
`{ kind: 'direct_agent', mode: 'new_topic', agentId, title }` and a caller-generated
`Idempotency-Key` creates a distinct participant-only topic. The server binds the key to the
caller and hashes the original request, so retries preserve the ID after renaming or archiving,
while changed original fields conflict. The creator and the same-workspace Agent are the
initial audience. Workspace membership alone does not grant private topic history access.
Creation retries also recheck current audience, including after archive or participant removal.

The old creation request retains its default-lane semantics. Its separate partial unique
index applies only to `direct-agent:` keys; opening it never chooses a new topic. The
legacy default lane retains its original audience, and reopening an archived lane creates a
new history. No migration merges conversations, changes participants, rewrites messages,
or adds native session ownership. Channel identity plus Agent identity is the isolation
binding; a later execution adapter must use that canonical binding.

Workspace event delivery enforces that audience for replay and live pages, including for
owners and admins. Missing or foreign references are withheld. Batched indexed projections
avoid one query per event; the database regression compares five-event and 120-event pages.

When a workspace-visible conversation becomes participant-only, a denied former reader receives
only a sequence/cursor audience-change signal. Resident query data and channel/thread selections
are cleared before refetch; retained transcripts and late responses must match the new audience
generation. Private-from-creation channels and hidden projects disclose no conversation identity.
The actual QueryClient and mounted Solid resource regressions cover this cache-revocation repair.

## F2 acceptance map

| Issue requirement                                                         | Implementation and evidence                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit security scope, audience and isolated conversation+Agent binding | Canonical Channel carries workspace ID, Agent ID and participant visibility/audience; messages bind to that Channel. `conversations.test.ts` checks distinct topic histories and nonparticipant denial; `event-audience.test.ts` checks current audience across replay/live classification.                                                                                                        |
| Deliberate new-topic keys and coordinated uniqueness migration            | Caller-scoped keys and original-request hashes preserve retry identity without selecting the default lane. DB/client/data tests cover two topics, changed requests, caller isolation and legacy retries; `lead-topic-migration.test.ts` applies actual 0042 SQL to the old index shape.                                                                                                            |
| Workspace authorization separate from conversation authorization          | Current membership and Channel audience are checked separately; owner/admin cannot bypass participant-only history. Wrong-workspace/nonparticipant/removed-participant tests and cache-revocation tests cover denial; newly created topics inherit no other history.                                                                                                                               |
| Preserve archive, search/read-state and legacy endpoint scope             | Migration test preserves archived bodies, audiences and read frontiers. New `topic-read-state-search.test.ts` explicitly covers topic-scoped search, independent Channel/thread frontiers, archive persistence, current audience removal, empty new-topic history and unchanged legacy lane. The fresh PostgreSQL run passed with the migration, audience and existing search/read-state fixtures. |

Archived channels remain excluded from the normal search, read-state and message endpoints;
their canonical bodies and read frontiers remain stored. This preserves existing endpoint scope
rather than introducing an archive-reading API. F2 acceptance does not require F1 automatic
provisioning, U1/U2 model/runtime integration or live-provider execution.

## Migration and rollback

Apply 0042 before deploying the new columns or topic callers. Its snapshot deliberately
preserves all staged Home, workspace-deletion and task-retention declarations from 0041,
even while their runtime declaration is awaiting canonical integration. Generating from
the older runtime declarations must not remove these expansions.

The real PostgreSQL migration fixture applies the reviewed SQL to old-shape fixtures and
compares original Agent IDs/CP IDs, active and archived channel identities, private bodies,
participants, timestamps and read frontiers before and after. Other integration fixtures
exercise duplicate/concurrent setup, two topic histories, archived reads, changed requests,
wrong-workspace requests and nonparticipant denial. Fixtures establish local database
behavior, not a production data inventory or a live runtime/provider qualification.

Rollback keeps the expanded columns and histories. Do not restore the global direct-Agent
unique index after topics exist: it would reject multiple legitimate topics. A compatible
reader can continue serving old scoped endpoints; topic creation can be disabled while
new histories remain readable. Destructive rollback, production backfill and rollout require
their own inventory and acceptance evidence.

## Integration boundary

The pinned SDK lacks the new model-connection operations. The existing connector credential
UI cannot imply a model-ready connection. U1's safe reason/remedy projection is tested
separately and is not wired to a provider or UI. U2 requires the canonical CP admission
service, current model selection and audience-authorized terminal publication. Ordinary
message persistence, runtime status inspection and direct project sessions do not call a
lead or claim dispatch.

## Reproducible foundation checks

Local qualification uses Node 24.21.0, Bun 1.4.0 and an isolated PostgreSQL instance,
with migrations through 0042 applied before running the foundation fixtures:

```sh
bun test packages/db/tests/integration/workspace-leads.test.ts packages/db/tests/integration/conversations.test.ts packages/db/tests/integration/event-audience.test.ts packages/db/tests/integration/lead-topic-migration.test.ts
bun test packages/db/tests/integration/topic-read-state-search.test.ts
bun test packages/api-client/tests/unit/agents.test.ts packages/api-client/tests/unit/conversations.test.ts packages/data/tests/unit/conversations.test.ts apps/web/test/agent-profile-availability.test.ts
bun test scripts/docs-boundary.test.ts
```

The event audience regressions failed before the fix and passed afterward. Independent
review reran the isolated database and focused client/server checks with no actionable
introduced regression. No screenshots, browser acceptance, production migration,
credential setup, model inference or live provider result is implied by these checks.

## F2 local qualification on canonical main

The F2-only source was reconciled onto canonical `a4c4690a`; U1/U2 intent, model and
candidate-runtime work remains separately preserved and is absent from this PR.
A fresh isolated PostgreSQL database applied migrations through 0042 and verified
a deterministic rerun (43 migration entries, including 0000).

| Check                                                                     | Result                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused database suite (six files, including `read-state-search.test.ts`) | 17 passed, 0 failed, 208 assertions; includes distinct topic search/read frontiers, archived bodies/frontiers, legacy lanes and hidden-project audience denial.              |
| `bun run format:check` and `bun run lint`                                 | Formatting passed; 17 lint tasks passed with zero warnings/errors.                                                                                                           |
| `bun run typecheck`                                                       | 31 tasks passed.                                                                                                                                                             |
| `bun run test:unit`                                                       | 30 tasks passed; coverage lane 302 passed, 0 failed, 7,163 assertions and 92.28% line coverage. Desktop suite: 1,269 passed with four existing packaged-only skips.          |
| `bun run build` and fresh `bun run --cwd apps/web build`                  | 15 workspace tasks passed; fresh production web build passed and verified 103 rendered shared UI modules against 187 Tailwind sources.                                       |
| `bun run --cwd apps/web start:check-bundle`                               | Fresh candidate production client module/size gate passed with unchanged limits.                                                                                             |
| Focused data/state/Solid-resource/SSE/source-boundary lane                | 89 passed, 0 failed, 318 assertions across 20 files. The mounted query/resource test is runtime evidence; ConversationSurface composition assertions remain source evidence. |

The additional standalone `node scripts/check-dev-view-bundle.mjs` guard fails
on canonical main as well as this candidate: canonical 215,770 bytes and candidate
215,710 bytes against the unchanged 114,688-byte entry/layout cap. The candidate
is 60 bytes smaller. This is retained as a pre-existing Dev View performance
follow-up; no cap or test was changed. `start:verify` and the TanStack Start PR
workflow invoke the passing `start:check-bundle`, rather than this standalone
guard. No complete performance, browser, packaged-desktop, production migration,
provider or runtime qualification is claimed.

Normal commit hooks and the final immutable PR head are recorded in the PR's
qualification receipt. Required hosted checks and Task8's exact-head review
remain the ready/merge boundary.
