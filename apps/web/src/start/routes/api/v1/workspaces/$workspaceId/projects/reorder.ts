import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../../server/request-scope'
import { reorderProjects } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../../../../server/workspace-authorization'
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
  const authorization = await authorizeWorkspace(
    resolution.principal,
    'workspace.update',
    workspaceId
  )
  if (!authorization.allowed) return workspaceUnavailableResponse(request)
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
  try {
    const projects = await reorderProjects(
      applicationDatabase(),
      workspaceId,
      resolution.principal,
      projectIds
    )
    return workspaceJsonResponse(projects, resolution, request)
  } catch (error) {
    if (error instanceof Error && error.message === 'Project order conflict') {
      return workspaceInvalidRequestResponse(request)
    }
    throw error
  }
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
