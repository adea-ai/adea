import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../../server/request-scope'
import type { ApiProjectResponse, ApiProjectUpdateInput } from '@adea-ai/api-client'
import { archiveProject, getProjectForUser, isProjectSourceKind, updateProject } from '@adea-ai/db'

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

async function patch(request: Request, { params }: Context) {
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

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  const candidate = body as Record<string, unknown>
  const input: ApiProjectUpdateInput = {}
  for (const field of ['iconKey', 'name'] as const) {
    if (!(field in candidate)) continue
    const value = candidate[field]
    if (typeof value !== 'string') return workspaceInvalidRequestResponse(request)
    Object.assign(input, { [field]: value.trim() })
  }
  if ('sourceKind' in candidate) {
    if (!isProjectSourceKind(candidate.sourceKind)) return workspaceInvalidRequestResponse(request)
    Object.assign(input, { sourceKind: candidate.sourceKind })
  }
  if (
    Object.keys(input).length === 0 ||
    input.name === '' ||
    input.iconKey === '' ||
    (input.name?.length ?? 0) > 80 ||
    (input.iconKey?.length ?? 0) > 80
  ) {
    return workspaceInvalidRequestResponse(request)
  }
  try {
    const payload: ApiProjectResponse = {
      project: await updateProject(
        applicationDatabase(),
        workspaceId,
        projectId,
        resolution.principal,
        input
      ),
    }
    return workspaceJsonResponse(payload, resolution, request)
  } catch (error) {
    if (error instanceof Error && error.message === 'Project unavailable') {
      return workspaceUnavailableResponse(request)
    }
    throw error
  }
}

async function remove(request: Request, { params }: Context) {
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
    await archiveProject(applicationDatabase(), workspaceId, projectId, resolution.principal)
    return workspaceJsonResponse({ archived: true as const }, resolution, request)
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
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/projects/$projectId')({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      PATCH: ({ request, params }) => withRequestScope(() => patch(request, { params })),
      DELETE: ({ request, params }) => withRequestScope(() => remove(request, { params })),
      OPTIONS: ({ request }) => withRequestScope(() => options(request)),
    },
  },
})
