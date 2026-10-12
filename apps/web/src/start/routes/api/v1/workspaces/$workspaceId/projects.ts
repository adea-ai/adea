import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../server/request-scope'
import type { ApiProjectCreateInput, ApiProjectResponse } from '@adea-ai/api-client'
import { isProjectId, isProjectSourceKind, listProjectsForUser } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../server/database'
import { runAfterResponse } from '../../../../../../server/background-task'
import { initializeControlPlaneProjectState } from '../../../../../../server/control-plane-project-state'
import { controlPlaneScopeResolver } from '../../../../../../server/control-plane-scope'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../server/desktop-workspace'
import { applicationManagementOperations } from '../../../../../../server/management-composition'
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
  const operation = applicationManagementOperations()
  const outcome = await operation.projectCreate({
    iconKey: input.iconKey,
    ...(input.id ? { id: input.id } : {}),
    name: input.name,
    principal: resolution.principal,
    ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}),
    workspaceId,
  })
  if (!outcome.ok) {
    if (outcome.failure.code === 'conflict') return projectConflictResponse(request)
    if (outcome.failure.code === 'unavailable' || outcome.failure.code === 'forbidden')
      return workspaceUnavailableResponse(request)
    throw new Error('Project creation failed')
  }
  const payload: ApiProjectResponse = { project: outcome.value }
  // ADR 0013: initialize the project's Control Plane state once the row has
  // committed, after the response and in its own request scope (its own
  // database connection), so a slow or failing Control Plane never fails
  // or delays project creation.
  const projectId = payload.project.id
  runAfterResponse(() =>
    withRequestScope(() =>
      initializeControlPlaneProjectState(controlPlaneScopeResolver(workspaceId, projectId))
    )
  )
  return workspaceJsonResponse(payload, resolution, request, { status: 201 })
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
