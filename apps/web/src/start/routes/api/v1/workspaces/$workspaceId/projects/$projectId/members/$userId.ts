import { createFileRoute } from '@tanstack/solid-router'
import type { ApiProjectMemberRemoveResponse, ApiProjectMemberResponse } from '@adea-ai/api-client'
import { isProjectMemberRole } from '@adea-ai/db'

import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../../server/desktop-workspace'
import { applicationManagementOperations } from '../../../../../../../../../server/management-composition'
import { withRequestScope } from '../../../../../../../../../server/request-scope'
import { isUuid } from '../../../../../../../../../server/sharing-request'
import { resolveWorkspacePrincipal } from '../../../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../../../server/workspace-response'

type Params = Readonly<{ projectId: string; userId: string; workspaceId: string }>

/** Owners and admins (`membership.manage`) list people on a project and set their role. */
async function authorized(request: Request, params: Params) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return { response: rejected }
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return { response: workspaceUnavailableResponse(request, 401) }
  if (!isUuid(params.projectId) || !isUuid(params.userId))
    return { response: workspaceUnavailableResponse(request) }
  return { resolution }
}

async function put(request: Request, params: Params) {
  const { resolution, response } = await authorized(request, params)
  if (!resolution) return response
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Object.keys(body).length !== 1 ||
    !isProjectMemberRole(body.role)
  )
    return workspaceInvalidRequestResponse(request)
  const outcome = await applicationManagementOperations().projectMemberSet({
    principal: resolution.principal,
    projectId: params.projectId,
    role: body.role,
    userId: params.userId,
    workspaceId: params.workspaceId,
  })
  if (!outcome.ok) {
    if (outcome.failure.code === 'unavailable' || outcome.failure.code === 'forbidden')
      return workspaceUnavailableResponse(request)
    throw new Error('Project member update failed')
  }
  const payload: ApiProjectMemberResponse = { member: outcome.value }
  return workspaceJsonResponse(payload, resolution, request)
}

async function remove(request: Request, params: Params) {
  const { resolution, response } = await authorized(request, params)
  if (!resolution) return response
  const outcome = await applicationManagementOperations().projectMemberRemove({
    principal: resolution.principal,
    projectId: params.projectId,
    userId: params.userId,
    workspaceId: params.workspaceId,
  })
  if (!outcome.ok) {
    if (outcome.failure.code === 'unavailable' || outcome.failure.code === 'forbidden')
      return workspaceUnavailableResponse(request)
    throw new Error('Project member removal failed')
  }
  const payload: ApiProjectMemberRemoveResponse = { removed: outcome.value }
  return workspaceJsonResponse(payload, resolution, request)
}

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/projects/$projectId/members/$userId'
)({
  server: {
    handlers: {
      PUT: ({ request, params }) =>
        params?.workspaceId && params.projectId && params.userId
          ? withRequestScope(() => put(request, params))
          : workspaceInvalidRequestResponse(request),
      DELETE: ({ request, params }) =>
        params?.workspaceId && params.projectId && params.userId
          ? withRequestScope(() => remove(request, params))
          : workspaceInvalidRequestResponse(request),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
