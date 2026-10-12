import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../../server/request-scope'
import type { ApiProjectResponse } from '@adea-ai/api-client'
import { getProjectForUser } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../server/desktop-workspace'
import { applicationManagementOperations } from '../../../../../../../server/management-composition'
import { updateProjectRequest } from '../../../../../../../server/project-management-request'
import { authorizeWorkspace } from '../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../server/workspace-principal'
import {
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../server/workspace-response'

type Context = { params: { projectId: string; workspaceId: string } }
async function get(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { projectId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const authorization = await authorizeWorkspace(
    resolution.principal,
    'workspace.read',
    workspaceId
  )
  if (!authorization.allowed) return workspaceUnavailableResponse(request)
  const project = await getProjectForUser(
    applicationDatabase(),
    workspaceId,
    projectId,
    resolution.principal
  )
  if (!project) return workspaceUnavailableResponse(request)
  const payload: ApiProjectResponse = { project }
  return workspaceJsonResponse(payload, resolution, request, {
    headers: { 'cache-control': 'private, no-store' },
  })
}

async function remove(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { projectId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const outcome = await applicationManagementOperations().projectArchive({
    principal: resolution.principal,
    projectId,
    workspaceId,
  })
  if (!outcome.ok) return workspaceUnavailableResponse(request)
  return workspaceJsonResponse({ archived: true as const }, resolution, request)
}

function options(request: Request) {
  return handleDesktopWorkspacePreflight(request)
}
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/projects/$projectId')({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      PATCH: ({ request, params }) =>
        withRequestScope(() => updateProjectRequest(request, { params })),
      DELETE: ({ request, params }) => withRequestScope(() => remove(request, { params })),
      OPTIONS: ({ request }) => withRequestScope(() => options(request)),
    },
  },
})
