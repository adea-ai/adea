import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../server/request-scope'
import type { ApiWorkspaceResponse, ApiWorkspaceUpdateResponse } from '@adea-ai/api-client'
import {
  getWorkspaceForUser,
  listAgentsForUser,
  listTasksForUser,
  updateWorkspace,
  WorkspaceVersionConflictError,
} from '@adea-ai/db'

import { applicationDatabase } from '../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../server/workspace-principal'
import { parseWorkspaceUpdate } from '../../../../server/workspace-request'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../server/workspace-response'
async function get(request: Request, { params }: { params: { workspaceId: string } }) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const authorization = await authorizeWorkspace(
    resolution.principal,
    'workspace.read',
    workspaceId
  )
  if (!authorization.allowed) return workspaceUnavailableResponse(request)

  const workspace = await getWorkspaceForUser(
    applicationDatabase(),
    workspaceId,
    resolution.principal
  )
  if (!workspace) return workspaceUnavailableResponse(request)

  const [agents, tasks] = await Promise.all([
    listAgentsForUser(applicationDatabase(), workspaceId, resolution.principal),
    listTasksForUser(applicationDatabase(), workspaceId, resolution.principal),
  ])
  const response: ApiWorkspaceResponse = {
    workspace,
    agents,
    tasks,
  }

  return workspaceJsonResponse(response, resolution, request, {
    headers: { 'cache-control': 'private, no-store' },
  })
}

async function patch(request: Request, { params }: { params: { workspaceId: string } }) {
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
  const parsed = parseWorkspaceUpdate(body)
  if (!parsed) return workspaceInvalidRequestResponse(request)

  try {
    const workspace = await updateWorkspace(
      applicationDatabase(),
      workspaceId,
      resolution.principal,
      parsed
    )
    const response: ApiWorkspaceUpdateResponse = { workspace }
    return workspaceJsonResponse(response, resolution, request)
  } catch (error) {
    if (error instanceof WorkspaceVersionConflictError)
      return workspaceJsonResponse(
        { code: 'workspace_version_conflict', message: 'Workspace version conflict' },
        resolution,
        request,
        { status: 409 }
      )
    return workspaceUnavailableResponse(request)
  }
}

function options(request: Request) {
  return handleDesktopWorkspacePreflight(request)
}
export const Route = createFileRoute('/api/workspaces/$workspaceId')({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      PATCH: ({ request, params }) => withRequestScope(() => patch(request, { params })),
      OPTIONS: ({ request }) => withRequestScope(() => options(request)),
    },
  },
})
