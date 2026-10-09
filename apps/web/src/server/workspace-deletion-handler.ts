import type { AgentHqDatabase } from '@adea-ai/db'
import type { WorkspacePrincipalResolution } from './workspace-principal'
import {
  deleteWorkspace,
  beginWorkspaceDeletion,
  WorkspaceCleanupRequiredError,
  WorkspacePersonalProtectedError,
  listWorkspacesForUser,
  WorkspaceVersionConflictError,
} from '@adea-ai/db'
import type { ApiWorkspaceDeleteResponse } from '@adea-ai/api-client'
import {
  guardDesktopWorkspaceRequest,
  trustedDesktopWorkspaceRequest,
  desktopTrustedOrigins,
} from './desktop-workspace'
import {
  parseWorkspaceDeletion,
  workspaceDeletionOriginAllowed,
} from './workspace-deletion-request'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'

export async function workspaceDeletionPost(
  request: Request,
  workspaceId: string,
  dependencies: Readonly<{
    database(): AgentHqDatabase
    resolvePrincipal(request: Request): Promise<WorkspacePrincipalResolution | null>
  }>
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  if (!workspaceDeletionOriginAllowed(request)) return workspaceUnavailableResponse(request, 403)
  const resolution = await dependencies.resolvePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(workspaceId))
    return workspaceInvalidRequestResponse(request)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  const input = parseWorkspaceDeletion(body)
  if (!input) return workspaceInvalidRequestResponse(request)
  try {
    const device = trustedDesktopWorkspaceRequest(request, desktopTrustedOrigins())
    if ((body as { phase?: unknown }).phase === 'prepare') {
      if (!device) return workspaceUnavailableResponse(request, 403)
      await beginWorkspaceDeletion(
        dependencies.database(),
        workspaceId,
        resolution.principal,
        input
      )
      return workspaceJsonResponse({ workspaceId, cleanupPending: true }, resolution, request, {
        headers: { 'cache-control': 'no-store' },
      })
    }
    await deleteWorkspace(dependencies.database(), workspaceId, resolution.principal, {
      ...input,
      device,
    })
    const workspaces = await listWorkspacesForUser(dependencies.database(), resolution.principal)
    const payload: ApiWorkspaceDeleteResponse = { deleted: true, workspaceId, workspaces }
    return workspaceJsonResponse(payload, resolution, request)
  } catch (error) {
    if (error instanceof WorkspacePersonalProtectedError)
      return workspaceJsonResponse(
        { code: 'workspace_personal_protected', message: error.message },
        resolution,
        request,
        { status: 409, headers: { 'cache-control': 'no-store' } }
      )
    if (error instanceof WorkspaceCleanupRequiredError)
      return workspaceJsonResponse(
        { message: error.message, code: 'workspace_deletion_cleanup_required' },
        resolution,
        request,
        { status: 409, headers: { 'cache-control': 'no-store' } }
      )
    if (error instanceof WorkspaceVersionConflictError)
      return workspaceJsonResponse(
        {
          code: 'workspace_version_conflict',
          message: 'Workspace changed. Check its current name and confirm again.',
        },
        resolution,
        request,
        { status: 409 }
      )
    if (error instanceof Error && error.message === 'Workspace unavailable')
      return workspaceUnavailableResponse(request)
    return workspaceJsonResponse(
      { code: 'workspace_deletion_failed', message: 'Workspace could not be deleted. Try again.' },
      resolution,
      request,
      { status: 500 }
    )
  }
}
