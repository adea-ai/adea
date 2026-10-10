/**
 * The human project-update request handler (M14.03.1, #1215).
 *
 * The route module wraps this in its router/request-scope boundary; keeping the
 * handler in a plain server module lets the route-flow lane exercise the
 * genuine desktop authentication, body parsing and shared management
 * composition without the solid-router runtime (the same pattern as
 * `account-directory-request.ts`).
 */
import type { ApiProjectResponse, ApiProjectUpdateInput } from '@adea-ai/api-client'
import { isProjectSourceKind } from '@adea-ai/db'

import { guardDesktopWorkspaceRequest } from './desktop-workspace'
import { applicationManagementOperations } from './management-composition'
import { resolveWorkspacePrincipal } from './workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'

export type ProjectRequestContext = {
  params: { projectId: string; workspaceId: string }
}

export async function updateProjectRequest(
  request: Request,
  { params }: ProjectRequestContext
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
  const candidate = body as Record<string, unknown>
  const input: ApiProjectUpdateInput = {}
  for (const field of ['iconKey', 'name'] as const) {
    if (!(field in candidate)) continue
    const value = candidate[field]
    if (typeof value !== 'string') return workspaceInvalidRequestResponse(request)
    Object.assign(input, { [field]: value.trim() })
  }
  if ('sourceKind' in candidate) {
    if (!isProjectSourceKind(candidate.sourceKind)) return workspaceInvalidRequestResponse(request)
    Object.assign(input, { sourceKind: candidate.sourceKind })
  }
  if (
    Object.keys(input).length === 0 ||
    input.name === '' ||
    input.iconKey === '' ||
    (input.name?.length ?? 0) > 80 ||
    (input.iconKey?.length ?? 0) > 80
  ) {
    return workspaceInvalidRequestResponse(request)
  }
  const outcome = await applicationManagementOperations().projectUpdate({
    ...(input.iconKey !== undefined ? { iconKey: input.iconKey } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    principal: resolution.principal,
    projectId,
    ...(input.sourceKind !== undefined ? { sourceKind: input.sourceKind } : {}),
    workspaceId,
  })
  if (!outcome.ok) {
    if (outcome.failure.code === 'unavailable' || outcome.failure.code === 'forbidden')
      return workspaceUnavailableResponse(request)
    throw new Error('Project update failed')
  }
  const payload: ApiProjectResponse = { project: outcome.value }
  return workspaceJsonResponse(payload, resolution, request)
}
