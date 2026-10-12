import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../server/request-scope'

import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../server/desktop-workspace'
import { applicationManagementOperations } from '../../../../../server/management-composition'
import { resolveWorkspacePrincipal } from '../../../../../server/workspace-principal'
import {
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../server/workspace-response'
async function post(request: Request, { params }: { params: { workspaceId: string } }) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const workspaceId = (await params).workspaceId
  const outcome = await applicationManagementOperations().workspaceReopen({
    principal: resolution.principal,
    workspaceId,
  })
  if (!outcome.ok) return workspaceUnavailableResponse(request)
  return workspaceJsonResponse({ workspace: outcome.value }, resolution, request)
}

function options(request: Request) {
  return handleDesktopWorkspacePreflight(request)
}
export const Route = createFileRoute('/api/workspaces/$workspaceId/reopen')({
  server: {
    handlers: {
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => withRequestScope(() => options(request)),
    },
  },
})
