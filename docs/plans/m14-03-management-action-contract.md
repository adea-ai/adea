# M14.03 management-action contract handoff: #1218 → #1215

- Status: active lane handoff (2026-10-08).
- Lane: **#1218** — preserve memory provenance/audience and explicit project
  state promotion; preview sensitive/dirty-worktree cleanup.
- Sibling: **#1215** — route management through shared audited APIs
  (`feat/issue-1215-management-audit-apis`).
- Base: `413aa9735` (both lanes start there).
- Contract sources: REQ 022,033,050,052–058,086,087; tests A11,A14,A33,A35;
  reuse gate [#811](https://github.com/adea-ai/adea/issues/811).

This note is the coordination boundary. It lists what this lane owns, the
exact hunks it lands in shared files, and the integration hunks proposed for
the sibling lane. The sibling lane should **not** edit this lane's files; it
consumes the exported functions/types instead.

## Ownership map

| Source                                                                           | Owner | Notes                                                            |
| -------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------- |
| `apps/desktop/shell/src/memory/provenance.ts`                                    | #1218 | Memory provenance/audience guard; consumed by `memory/store.ts`. |
| `apps/desktop/shell/src/dev-runtime/worktrees/cleanup-preview.ts`                | #1218 | Pure, read-only cleanup preview (both gates).                    |
| `packages/db/src/project-state-policy.ts`                                        | #1218 | Pure promotion decision + transactional `promoteProjectState`.   |
| `packages/db/src/agent-persona-policy.ts`                                        | #1218 | Persona guard; called by `changeAgentProfile`.                   |
| `apps/desktop/tests/memory-provenance.test.ts`                                   | #1218 | Provenance/audience/promotion tests.                             |
| `apps/desktop/tests/worktree-cleanup-preview.test.ts`                            | #1218 | Stale/revocation/crash-retry/both-gate tests.                    |
| `packages/db/tests/unit/{project-state-policy,agent-persona-policy}.test.ts`     | #1218 | Pure policy tests.                                               |
| `packages/db/tests/integration/project-state-promotion.test.ts`                  | #1218 | Promotion/stale/opt-in integration.                              |
| Shared management action envelope, routes, api-client, TanStack mutation surface | #1215 | Proposed hunks below; #1218 does not touch these.                |

## Shared contract #1215 should define (proposal, not this lane's write)

One envelope for every management action, with the domain modules above as
the decision hooks:

```ts
export type ManagementActionProvenance = Readonly<{
  actorKind: 'user' | 'agent' | 'system'
  source: 'human' | 'lead' | 'automation'
  actorUserId?: string
  agentId?: string
  leadTurnId?: string
}>

export type ManagementActionAudience = Readonly<{
  workspaceId: string
  projectId?: string
  visibility?: ProjectVisibility
  /** A tool call may never address another workspace than its session scope. */
  sessionId?: string
}>

export type ManagementActionRequest = Readonly<{
  action:
    | 'memory.accept_proposal'
    | 'memory.reject_proposal'
    | 'memory.set_injection'
    | 'project.promote_state'
    | 'agent.change_persona'
    | 'worktree.cleanup_preview'
  audience: ManagementActionAudience
  provenance: ManagementActionProvenance
  expectedRevision: string | number
  confirmation: Readonly<{ required: boolean; token?: string }>
  idempotencyKey: string
}>
```

Invariants the envelope must carry, matching this lane's guards:

1. **Provenance is preserved, not re-labelled.** A lead/agent tool call
   records the same provenance the domain decision returns; an accept may not
   present a new `source`.
2. **Audience is the workspace, exactly.** A request for another workspace is
   indistinguishable from a missing resource on every path.
3. **Revisions are exact and stale writes refuse.** `memory` uses the integer
   `revision`, `project` the observed `updatedAt` (until the version column
   below), `agent` the profile revision.
4. **Confirmation is explicit opt-in** for promotion and every destructive
   cleanup step; absence refuses.
5. **Audit and recovery are append-only.** `project.restored` /
   `channel.restored` are now registered. Cleanup recovery is journal-driven:
   a completed step is never repeated.

## Hunks this lane lands in shared files (already in the #1218 commit)

The sibling lane rebases over these; none touch route, client or envelope
code.

### `packages/db/src/event-contract.ts`

```diff
   'channel.read': { schemaVersion: 1, aggregateType: 'channel', aggregateIdKey: 'channelId' },
+  'channel.restored': { schemaVersion: 1, aggregateType: 'channel', aggregateIdKey: 'channelId' },
   'channel.unread': { schemaVersion: 1, aggregateType: 'channel', aggregateIdKey: 'channelId' },
@@
   'project.reordered': { schemaVersion: 1, aggregateType: 'project' },
+  'project.restored': { schemaVersion: 1, aggregateType: 'project', aggregateIdKey: 'projectId' },
   'project.updated': { schemaVersion: 1, aggregateType: 'project', aggregateIdKey: 'projectId' },
```

### `packages/db/src/index.ts`

Adds the export blocks for `project-state-policy.ts` and
`agent-persona-policy.ts` (see the diff in the #1218 PR). Both are additive;
no existing export changes.

### `apps/desktop/shell/src/memory/store.ts`

`accept` now routes through `promoteWithMemoryGuard` (from
`memory/provenance.ts`), which pins status/revision and refuses a presented
provenance change. Observable codes are unchanged (`memory_stale_revision`,
`memory_invalid_state`, `memory_not_found`).

### `packages/db/src/agents.ts`

`changeAgentProfile` calls `decideAgentPersonaChange` before the UPDATE and
writes the normalized plan values. No authority field is written.

## Integration hunks proposed to #1215 (not applied here)

### 1. `project.promote_state` route

New file
`apps/web/src/start/routes/api/v1/workspaces/$workspaceId/projects/$projectId/restore.ts`,
then regenerate `apps/web/src/start/routeTree.gen.ts`:

```ts
import { createFileRoute } from '@tanstack/solid-router'
import type { ApiProjectResponse, ApiProjectRestoreInput } from '@adea-ai/api-client'
import { promoteProjectState, ProjectStatePromotionError } from '@adea-ai/db'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import { applicationDatabase } from '../../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../../server/workspace-response'

async function post(
  request: Request,
  { params }: { params: { projectId: string; workspaceId: string } }
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { projectId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const authorization = await authorizeWorkspace(
    resolution.principal,
    'workspace.update',
    workspaceId
  )
  if (!authorization.allowed) return workspaceUnavailableResponse(request)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  const candidate = body as Record<string, unknown>
  const input: ApiProjectRestoreInput | null =
    candidate.confirmed === true && typeof candidate.expectedUpdatedAt === 'string'
      ? { confirmed: true, expectedUpdatedAt: candidate.expectedUpdatedAt }
      : null
  if (!input) return workspaceInvalidRequestResponse(request)
  try {
    const payload: ApiProjectResponse = {
      project: await promoteProjectState(
        applicationDatabase(),
        workspaceId,
        projectId,
        resolution.principal,
        input
      ),
    }
    return workspaceJsonResponse(payload, resolution, request)
  } catch (error) {
    if (error instanceof ProjectStatePromotionError) {
      if (error.reason === 'promotion_stale') {
        return workspaceJsonResponse(
          { code: 'project_conflict', message: error.message },
          resolution,
          request,
          { status: 409 }
        )
      }
      return workspaceUnavailableResponse(request)
    }
    throw error
  }
}

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/projects/$projectId/restore')(
  {
    server: {
      handlers: {
        POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
        OPTIONS: ({ request }) => withRequestScope(() => handleDesktopWorkspacePreflight(request)),
      },
    },
  }
)
```

### 2. `packages/api-client/src/index.ts`

```diff
 export type ApiProjectUpdateInput = Readonly<{
   iconKey?: string
   name?: string
   sourceKind?: ProjectSourceKind
 }>
+
+/** Explicit promotion of an archived project; `expectedUpdatedAt` is the
+ * observed revision and `confirmed` is the owner's explicit opt-in. */
+export type ApiProjectRestoreInput = Readonly<{
+  confirmed: true
+  expectedUpdatedAt: string
+}>
```

### 3. `packages/data/src/index.ts`

Add beside the existing project mutation options:

```ts
export const projectRestoreMutationOptions = {
  mutationFn: ({
    workspaceId,
    projectId,
    input,
  }: Readonly<{ workspaceId: string; projectId: string; input: ApiProjectRestoreInput }>) =>
    apiClient.projects.restore(workspaceId, projectId, input),
  onSuccess: (
    _project: ProjectSummary,
    variables: Readonly<{ workspaceId: string }>,
    queryClient: QueryClient
  ) => {
    void queryClient.invalidateQueries({ queryKey: projectQueryKeys.list(variables.workspaceId) })
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.events(variables.workspaceId),
    })
  },
}
```

### 4. `packages/types/src/dev-runtime.ts` — preview consequences on the plan

`cleanup-preview.ts` is pure and already returns the consequences; the shared
plan DTO can carry them so one response serves both the human confirmation and
the lead tool:

```diff
 export type MutationPlan = Readonly<{
   id: string
   operation: DevOperation
   scope: Scope
   resource: Readonly<{ kind: string; id: string; generation: number }>
   factVersions: Readonly<Record<string, string>>
   steps: readonly Readonly<{
     id: string
     kind: string
     targetId: string
     dependsOn: readonly string[]
   }>[]
   blockers: readonly CleanupBlocker[]
+  /** Read-only consequences of the plan; never authority to execute. */
+  consequences?: readonly Readonly<{
+    kind: string
+    blocking: boolean
+    detail: string
+  }>[]
   requiredApprovalIds: readonly string[]
   digest: string
```

The corresponding hunk in
`apps/desktop/shell/src/dev-runtime/worktrees/register.ts`
(`dev.worktree.cleanupPlan`) is:

```ts
+      const preview = buildCleanupPreview({
+        facts: plan.facts,
+        selectedSteps: plan.selectedSteps,
+      })
...satisfies MutationPlan =>
         blockers: plan.blockers.map(...),
+        consequences: preview.consequences.map(({ kind, blocking, detail }) => ({
+          kind,
+          blocking,
+          detail,
+        })),
```

### 5. `projects.version` (follow-up hardening, proposed)

The promotion flow uses the exact observed `updatedAt` as its revision token
because `projects` has no version column. Concurrency is still exact (row
lock + compare-and-swap). When the shared API lane adds revisions to projects,
these are the exact hunks:

```diff
--- a/packages/db/src/schema/projects.ts
+++ b/packages/db/src/schema/projects.ts
@@
   lifecycleState: projectLifecycleState('lifecycle_state').default('active').notNull(),
+  version: integer('version').default(1).notNull(),
   visibility: projectVisibility('visibility').default('workspace').notNull(),
@@
     check('projects_sort_order_nonnegative', sql`${table.sortOrder} >= 0`),
+    check('projects_version_positive', sql`${table.version} > 0`),
```

Then `promoteProjectState` swaps `expectedUpdatedAt: string` for
`expectedVersion: number` and CASes on `version` instead of `updatedAt`; the
`ProjectStatePromotionPlan` already exposes `expectedUpdatedAt`, so the rename
is mechanical.

## Validation in the #1218 lane

- `bun test apps/desktop/tests/{memory-provenance,workspace-memory-store,workspace-local-data,worktree-cleanup-preview,workspace-cleanup}.test.ts`
- `bun test packages/db/tests/unit`
- `bun --conditions=react-server test packages/db/tests/integration/{project-state-promotion,projects,agents}.test.ts`
- `bunx turbo run typecheck --filter=@adea-ai/db --filter=@adea-ai/desktop`
- `bunx turbo run lint --filter=@adea-ai/db --filter=@adea-ai/desktop`
