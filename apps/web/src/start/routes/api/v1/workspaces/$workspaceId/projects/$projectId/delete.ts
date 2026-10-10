import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import type { ApiProjectDeleteResponse } from '@adea-ai/api-client'

import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../server/desktop-workspace'
import { applicationManagementOperations } from '../../../../../../../../server/management-composition'
import { resolveWorkspacePrincipal } from '../../../../../../../../server/workspace-principal'
import {
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../../server/workspace-response'

type Context = { params: { projectId: string; workspaceId: string } }

/** Soft-delete: the project leaves every listing; its rows and history stay. */
async function post(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { projectId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const outcome = await applicationManagementOperations().projectDelete({
    principal: resolution.principal,
    projectId,
    workspaceId,
  })
  if (!outcome.ok) return workspaceUnavailableResponse(request)
  const payload: ApiProjectDeleteResponse = { deleted: true }
  return workspaceJsonResponse(payload, resolution, request)
}

function options(request: Request) {
  return handleDesktopWorkspacePreflight(request)
}
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/projects/$projectId/delete')({
  server: {
    handlers: {
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => withRequestScope(() => options(request)),
    },
  },
})
