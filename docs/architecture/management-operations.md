# Management operation routing

- Status: Implemented (2026-10-09), M14.03.1 (adea-ai/adea#1215).
- Scope: how human HTTP controls and workspace lead tools share one authorized
  management surface for configuration, memory, projects, worktrees and
  sessions, and which operations stay typed-unsupported until their upstream
  contract exists.

## Why

The parent slice (adea-ai/adea#1176) requires that a lead tool cannot take a
second, unaudited path to a change a human could also make. Before this slice,
project and workspace routes called their database functions directly with
their own `authorizeWorkspace` call, and there was no lead tool surface at all.
That made an equivalence claim untestable and left device-local operations with
no explicit "not from here yet" contract.

## The inventory

`packages/types/src/management.ts` is the closed catalog. Each operation names:

- its **domain** (`config`, `memory`, `project`, `worktree`, `session`) and
  **surface** (`cloud` or `device`);
- the exact **existing API** it executes through (`web` handler, desktop bridge
  method, or a `dev.*` Dev Runtime registry operation);
- its **workspace permission** (cloud) or Dev Runtime **capability** (device);
- its **revision** anchor (`workspace_version`, `workspace_order`,
  `memory_revision`, `project_order`, `project_revision` — the integer
  `ProjectSummary.version`, `worktree_generation`, `session_generation`,
  `plan_digest`), **confirmation** style (`none`, `explicit`, `plan_commit`),
  **audit** surface and **recovery** contract;
- the callable state per **lane** (`web`, `desktop`, `lead`), where every
  unsupported lane carries one of the typed reasons below.

## The gateway

`apps/web/src/server/management-gateway.ts` is the single enforcement point.
`createManagementGateway` checks lane support, requires a lead caller to carry
an already-resolved upstream turn authority, then authorizes the same user
principal through the same shared authorization API for both human and lead
callers. Authorization failures, stale revisions, conflicts, cleanup gates and
unknown internal errors are projected to bounded typed failures; raw error text
never reaches a caller.

`apps/web/src/server/management-operations.ts` binds each callable operation to
its existing database function. HTTP routes
(`apps/web/src/start/routes/...`) and
`apps/web/src/server/lead-management-tools.ts` both construct the same
operations object. The lead tool surface has no HTTP route and no database
access of its own; a lead tool without a resolved authority fails closed with
`upstream_authority_unavailable`, so this slice fabricates no grant.

## Typed unsupported reasons

| Reason                           | Meaning                                                                                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device_required`                | The operation exists only through the authorized local device host (memory, worktrees, sessions, preferences, connections, workspace deletion cleanup). The lead has no remote runtime channel yet.                                    |
| `upstream_authority_unavailable` | The canonical upstream turn/approval authority (control-plane R3/J2) is not released or installed; a lead tool call cannot be executed.                                                                                                |
| `not_implemented`                | No shared implementation or dedicated server-confirmed flow exists yet (for example the currently unused DB-only workspace archive path, and the per-user workspace ordering that is a personal preference rather than a lead action). |

## Regression coverage

- `packages/types/tests/management.test.ts` pins the catalog's shape, the
  `dev.*` bindings against the generated operation registry, and the lane
  classification.
- `apps/web/test/management-gateway.test.ts` pins human/lead parity, the
  fail-closed authority boundary, device refusal, denial attribution and the
  bounded error projection.
- `apps/web/test/management-operations.test.ts` pins executor wiring, the
  version/order conflict contracts and the dedicated confirmation operations.
- `apps/web/test/project-promotion-management.test.ts` pins the explicit
  `project.promote` path: `workspace.update` authorization, exact revision,
  typed stale-revision projection, unconfirmed refusal and lead-lane audit
  parity.
- `apps/web/test/lead-management-tools.test.ts` pins that the lead definitions
  are exactly the inventory's lead-callable slice and that execution routes
  through the same shared operations.

## Remaining integration boundary

The lead lane's cloud operations still require the upstream control-plane turn
authority (R3/J2) and the remote runtime-node channel for device-local
operations. Until those are released, the inventory and gateway record the
typed refusal rather than substituting a local grant.
