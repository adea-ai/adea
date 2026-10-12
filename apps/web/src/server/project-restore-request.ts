/**
 * The human project-restore request handler. Kept outside the file route so
 * the authenticated request path can be exercised with the route-flow DB
 * harness without loading the Solid router runtime.
 */
import type { ApiProjectResponse, ApiProjectRestoreInput } from '@adea-ai/api-client'

import { guardDesktopWorkspaceRequest } from './desktop-workspace'
import { applicationManagementOperations } from './management-composition'
import { resolveWorkspacePrincipal } from './workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'

export type ProjectRestoreRequestContext = {
  params: { projectId: string; workspaceId: string }
}

export async function restoreProjectRequest(
  request: Request,
  { params }: ProjectRestoreRequestContext
): Promise<Response> {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { projectId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return workspaceInvalidRequestResponse(request)
  const candidate = body as Record<string, unknown>
  const expectedVersion = candidate.expectedVersion
  const input: ApiProjectRestoreInput | null =
    candidate.confirmed === true &&
    typeof expectedVersion === 'number' &&
    Number.isSafeInteger(expectedVersion) &&
    expectedVersion >= 1
      ? { confirmed: true, expectedVersion }
      : null
  if (!input) return workspaceInvalidRequestResponse(request)
  const outcome = await applicationManagementOperations().projectPromote(
    {
      confirmed: input.confirmed,
      expectedVersion: input.expectedVersion,
      principal: resolution.principal,
      projectId,
      workspaceId,
    },
    undefined
  )
  if (!outcome.ok) {
    if (outcome.failure.code === 'stale_revision' || outcome.failure.code === 'conflict') {
      return workspaceJsonResponse(
        { code: 'project_conflict', message: outcome.failure.message },
        resolution,
        request,
        { status: 409 }
      )
    }
    return workspaceUnavailableResponse(request)
  }
  const payload: ApiProjectResponse = { project: outcome.value }
  return workspaceJsonResponse(payload, resolution, request)
}
