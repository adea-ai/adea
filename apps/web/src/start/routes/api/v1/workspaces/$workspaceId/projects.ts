import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../server/request-scope'
import type { ApiProjectCreateInput, ApiProjectResponse } from '@adea-ai/api-client'
import { createProject, isProjectId, isProjectSourceKind, listProjectsForUser } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../server/workspace-principal'
import {
  projectConflictResponse,
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../server/workspace-response'
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
  const result = await listProjectsForUser(applicationDatabase(), workspaceId, resolution.principal)
  return workspaceJsonResponse(result, resolution, request, {
    headers: { 'cache-control': 'private, no-store' },
  })
}

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
  const candidate = body as Record<string, unknown>
  if (candidate.id !== undefined && !isProjectId(candidate.id)) {
    return workspaceInvalidRequestResponse(request)
  }
  if (candidate.sourceKind !== undefined && !isProjectSourceKind(candidate.sourceKind)) {
    return workspaceInvalidRequestResponse(request)
  }
  const input: ApiProjectCreateInput = {
    iconKey: typeof candidate.iconKey === 'string' ? candidate.iconKey.trim() : '',
    name: typeof candidate.name === 'string' ? candidate.name.trim() : '',
    ...(isProjectId(candidate.id) ? { id: candidate.id.toLowerCase() } : {}),
    ...(isProjectSourceKind(candidate.sourceKind) ? { sourceKind: candidate.sourceKind } : {}),
  }
  if (!input.name || input.name.length > 80 || !input.iconKey || input.iconKey.length > 80) {
    return workspaceInvalidRequestResponse(request)
  }
  try {
    const payload: ApiProjectResponse = {
      project: await createProject(applicationDatabase(), workspaceId, resolution.principal, input),
    }
    return workspaceJsonResponse(payload, resolution, request, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Project unavailable') {
      return workspaceUnavailableResponse(request)
    }
    if (error instanceof Error && error.message === 'Project id conflict') {
      return projectConflictResponse(request)
    }
    throw error
  }
}

function options(request: Request) {
  return handleDesktopWorkspacePreflight(request)
}
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/projects')({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => withRequestScope(() => options(request)),
    },
  },
})
