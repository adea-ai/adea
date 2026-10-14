import type { AgentHqDatabase } from '@adea-ai/db'
import { listProjectsForUser } from '@adea-ai/db'
import type { UserPrincipalRef, WorkspacePermission } from '@adea-ai/types'

import { guardDesktopWorkspaceRequest } from './desktop-workspace'
import type { WorkspacePrincipalResolution } from './workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'

/**
 * The projects a caller may read in one workspace. Active projects only by default, so the sidebar's
 * list is unchanged. `includeArchived=true` lists archived projects beside them for the explicit
 * restore flow; visibility is the same project access scope either way, so a members-only project
 * stays hidden from anyone who is not on it. Any other query parameter or value is refused.
 */
export async function projectListGet(
  request: Request,
  workspaceId: string,
  dependencies: Readonly<{
    authorize(
      principal: UserPrincipalRef,
      permission: WorkspacePermission,
      workspaceId: string
    ): Promise<boolean>
    database(): AgentHqDatabase
    resolvePrincipal(request: Request): Promise<WorkspacePrincipalResolution | null>
  }>
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await dependencies.resolvePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await dependencies.authorize(resolution.principal, 'workspace.read', workspaceId)))
    return workspaceUnavailableResponse(request)
  const query = new URL(request.url).searchParams
  const includeArchived = query.get('includeArchived')
  if (
    [...query.keys()].some((key) => key !== 'includeArchived') ||
    (includeArchived !== null && includeArchived !== 'true' && includeArchived !== 'false')
  )
    return workspaceInvalidRequestResponse(request)
  const result = await listProjectsForUser(
    dependencies.database(),
    workspaceId,
    resolution.principal,
    includeArchived === 'true' ? { includeArchived: true } : {}
  )
  return workspaceJsonResponse(result, resolution, request, {
    headers: { 'cache-control': 'private, no-store' },
  })
}
