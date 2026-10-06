import { createFileRoute } from '@tanstack/solid-router'
import type { ApiProjectMemberRemoveResponse, ApiProjectMemberResponse } from '@adea-ai/api-client'
import { isProjectMemberRole, removeProjectMember, setProjectMember } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../../../../server/request-scope'
import { isUuid, sharingErrorResponse } from '../../../../../../../../../server/sharing-request'
import { authorizeWorkspace } from '../../../../../../../../../server/workspace-authorization'
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
  if (
    !(await authorizeWorkspace(resolution.principal, 'membership.manage', params.workspaceId))
      .allowed ||
    !isUuid(params.projectId) ||
    !isUuid(params.userId)
  )
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
  try {
    const payload: ApiProjectMemberResponse = {
      member: await setProjectMember(
        applicationDatabase(),
        params.workspaceId,
        params.projectId,
        resolution.principal,
        { role: body.role, userId: params.userId }
      ),
    }
    return workspaceJsonResponse(payload, resolution, request)
  } catch (error) {
    return sharingErrorResponse(error, resolution, request)
  }
}

async function remove(request: Request, params: Params) {
  const { resolution, response } = await authorized(request, params)
  if (!resolution) return response
  try {
    const payload: ApiProjectMemberRemoveResponse = {
      removed: await removeProjectMember(
        applicationDatabase(),
        params.workspaceId,
        params.projectId,
        resolution.principal,
        params.userId
      ),
    }
    return workspaceJsonResponse(payload, resolution, request)
  } catch (error) {
    return sharingErrorResponse(error, resolution, request)
  }
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
