import { archiveWorkspace, WorkspacePersonalProtectedError } from '@adea-ai/db'
import type { AgentHqDatabase } from '@adea-ai/db'
import type { ApiWorkspaceArchiveResponse } from '@adea-ai/api-client'
import type { UserPrincipalRef } from '@adea-ai/types'

import { guardDesktopWorkspaceRequest } from './desktop-workspace'
import type { WorkspacePrincipalResolution } from './workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'

/**
 * Archives one optional workspace for its owner. Archive is hidden, never erased: history and links
 * stay. Authority is the existing `workspace.archive` permission (owner only in the role matrix),
 * and `archiveWorkspace` repeats the owner check and refuses Home on the server. A repeat archive
 * finds no active membership and answers as unavailable, so the caller learns nothing new.
 */
export async function workspaceArchivePost(
  request: Request,
  workspaceId: string,
  dependencies: Readonly<{
    authorize(principal: UserPrincipalRef, workspaceId: string): Promise<boolean>
    database(): AgentHqDatabase
    resolvePrincipal(request: Request): Promise<WorkspacePrincipalResolution | null>
  }>
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await dependencies.resolvePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(workspaceId))
    return workspaceInvalidRequestResponse(request)
  if (!(await dependencies.authorize(resolution.principal, workspaceId)))
    return workspaceUnavailableResponse(request)
  try {
    await archiveWorkspace(dependencies.database(), workspaceId, resolution.principal)
    const payload: ApiWorkspaceArchiveResponse = { archived: true, workspaceId }
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    if (error instanceof WorkspacePersonalProtectedError)
      return workspaceJsonResponse(
        { code: 'workspace_personal_protected', message: error.message },
        resolution,
        request,
        { status: 409, headers: { 'cache-control': 'no-store' } }
      )
    if (error instanceof Error && error.message === 'Workspace unavailable')
      return workspaceUnavailableResponse(request)
    return workspaceJsonResponse(
      { code: 'workspace_archive_failed', message: 'Workspace could not be archived. Try again.' },
      resolution,
      request,
      { status: 500, headers: { 'cache-control': 'no-store' } }
    )
  }
}
