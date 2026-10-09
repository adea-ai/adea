import { createFileRoute } from '@tanstack/solid-router'
import type { ApiProjectResponse } from '@adea-ai/api-client'
import { isProjectVisibility } from '@adea-ai/db'

import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../server/desktop-workspace'
import { applicationManagementOperations } from '../../../../../../../../server/management-composition'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import { isUuid } from '../../../../../../../../server/sharing-request'
import { resolveWorkspacePrincipal } from '../../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../../server/workspace-response'

/** Owners and admins (`membership.manage`) decide who can see a project. */
async function patch(request: Request, workspaceId: string, projectId: string) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!isUuid(projectId)) return workspaceUnavailableResponse(request)
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
    !isProjectVisibility(body.visibility)
  )
    return workspaceInvalidRequestResponse(request)
  const outcome = await applicationManagementOperations().projectVisibilitySet({
    principal: resolution.principal,
    projectId,
    visibility: body.visibility,
    workspaceId,
  })
  if (!outcome.ok) {
    if (outcome.failure.code === 'unavailable' || outcome.failure.code === 'forbidden')
      return workspaceUnavailableResponse(request)
    throw new Error('Project visibility update failed')
  }
  const payload: ApiProjectResponse = { project: outcome.value }
  return workspaceJsonResponse(payload, resolution, request)
}

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/projects/$projectId/visibility'
)({
  server: {
    handlers: {
      PATCH: ({ request, params }) =>
        params?.workspaceId && params.projectId
          ? withRequestScope(() => patch(request, params.workspaceId, params.projectId))
          : workspaceInvalidRequestResponse(request),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
