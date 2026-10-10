import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../../server/request-scope'

import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../server/desktop-workspace'
import { applicationManagementOperations } from '../../../../../../../server/management-composition'
import { resolveWorkspacePrincipal } from '../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../server/workspace-response'
async function post(request: Request, { params }: { params: { workspaceId: string } }) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  const projectIds = (body as Record<string, unknown>).projectIds
  if (!Array.isArray(projectIds) || projectIds.some((id) => typeof id !== 'string' || !id.trim())) {
    return workspaceInvalidRequestResponse(request)
  }
  const outcome = await applicationManagementOperations().projectReorder({
    principal: resolution.principal,
    projectIds,
    workspaceId,
  })
  if (!outcome.ok) {
    if (outcome.failure.code === 'stale_revision') return workspaceInvalidRequestResponse(request)
    return workspaceUnavailableResponse(request)
  }
  return workspaceJsonResponse(outcome.value, resolution, request)
}

function options(request: Request) {
  return handleDesktopWorkspacePreflight(request)
}
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/projects/reorder')({
  server: {
    handlers: {
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => withRequestScope(() => options(request)),
    },
  },
})
