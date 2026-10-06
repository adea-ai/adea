import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import type { ApiProjectDeleteResponse } from '@adea-ai/api-client'
import { softDeleteProject } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../../../../../server/workspace-authorization'
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
  const authorization = await authorizeWorkspace(
    resolution.principal,
    'workspace.update',
    workspaceId
  )
  if (!authorization.allowed) return workspaceUnavailableResponse(request)
  try {
    await softDeleteProject(applicationDatabase(), workspaceId, projectId, resolution.principal)
    const payload: ApiProjectDeleteResponse = { deleted: true }
    return workspaceJsonResponse(payload, resolution, request)
  } catch (error) {
    if (error instanceof Error && error.message === 'Project unavailable') {
      return workspaceUnavailableResponse(request)
    }
    throw error
  }
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
