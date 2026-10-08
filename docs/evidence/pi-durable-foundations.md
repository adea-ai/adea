# Workspace lead and direct-topic foundations

This additive slice implements parts of [F1 (#1170)](https://github.com/adea-ai/adea/issues/1170)
and [F2 (#1171)](https://github.com/adea-ai/adea/issues/1171). It does not qualify a running
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
bun test packages/api-client/tests/unit/agents.test.ts packages/api-client/tests/unit/conversations.test.ts packages/data/tests/unit/conversations.test.ts apps/web/test/agent-profile-availability.test.ts
bun test scripts/docs-boundary.test.ts
```

The event audience regressions failed before the fix and passed afterward. Independent
review reran the isolated database and focused client/server checks with no actionable
introduced regression. No screenshots, browser acceptance, production migration,
credential setup, model inference or live provider result is implied by these checks.
