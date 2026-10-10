import { listArchivedWorkspacesForOwner } from '@adea-ai/db'
import type { AgentHqDatabase } from '@adea-ai/db'
import type { ApiArchivedWorkspacesResponse } from '@adea-ai/api-client'

import { guardDesktopWorkspaceRequest } from './desktop-workspace'
import type { WorkspacePrincipalResolution } from './workspace-principal'
import { workspaceJsonResponse, workspaceUnavailableResponse } from './workspace-response'

/**
 * The signed-in user's own archived workspaces, for discovery and durable reopen. The read is owner
 * scoped by `listArchivedWorkspacesForOwner`, so members, admins and other owners receive no archived
 * rows. It is not a role or permission change; reopen still runs its existing owner check.
 */
export async function workspaceArchivedGet(
  request: Request,
  dependencies: Readonly<{
    database(): AgentHqDatabase
    resolvePrincipal(request: Request): Promise<WorkspacePrincipalResolution | null>
  }>
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await dependencies.resolvePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const workspaces = await listArchivedWorkspacesForOwner(
    dependencies.database(),
    resolution.principal
  )
  const payload: ApiArchivedWorkspacesResponse = { workspaces }
  return workspaceJsonResponse(payload, resolution, request, {
    headers: { 'cache-control': 'no-store' },
  })
}
