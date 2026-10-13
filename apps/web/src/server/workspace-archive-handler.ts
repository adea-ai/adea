import type { ApiWorkspaceArchiveResponse } from '@adea-ai/api-client'
import type { WorkspacePrincipalResolution } from './workspace-principal'
import type { ManagementOperations } from './management-operations'
import { guardDesktopWorkspaceRequest } from './desktop-workspace'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'

/**
 * Archives one optional workspace through the shared management inventory.
 * The client must send the explicit confirmation captured by its dialog; the
 * lead lane binds the same confirmation into its signed exact-call decision.
 */
export async function workspaceArchivePost(
  request: Request,
  workspaceId: string,
  dependencies: Readonly<{
    operations(): ManagementOperations
    resolvePrincipal(request: Request): Promise<WorkspacePrincipalResolution | null>
  }>
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
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
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return workspaceInvalidRequestResponse(request)
  const input = body as Record<string, unknown>
  if (Object.keys(input).length !== 1 || input.confirmed !== true)
    return workspaceInvalidRequestResponse(request)

  try {
    const outcome = await dependencies.operations().workspaceArchive({
      confirmed: true,
      principal: resolution.principal,
      workspaceId,
    })
    if (!outcome.ok) {
      if (outcome.failure.reason === 'workspace_personal_protected')
        return workspaceJsonResponse(
          {
            code: 'workspace_personal_protected',
            message: 'Your personal workspace cannot be archived.',
          },
          resolution,
          request,
          { status: 409, headers: { 'cache-control': 'no-store' } }
        )
      if (
        outcome.failure.code === 'unavailable' ||
        outcome.failure.code === 'forbidden' ||
        outcome.failure.code === 'unsupported'
      )
        return workspaceUnavailableResponse(request)
      return workspaceJsonResponse(
        {
          code: 'workspace_archive_failed',
          message: 'Workspace could not be archived. Try again.',
        },
        resolution,
        request,
        { status: 500, headers: { 'cache-control': 'no-store' } }
      )
    }
    const payload: ApiWorkspaceArchiveResponse = { archived: true, workspaceId }
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch {
    return workspaceJsonResponse(
      { code: 'workspace_archive_failed', message: 'Workspace could not be archived. Try again.' },
      resolution,
      request,
      { status: 500, headers: { 'cache-control': 'no-store' } }
    )
  }
}
