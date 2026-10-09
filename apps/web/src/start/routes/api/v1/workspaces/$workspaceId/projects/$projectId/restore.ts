import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import type { ApiProjectResponse, ApiProjectRestoreInput } from '@adea-ai/api-client'

import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../server/desktop-workspace'
import { applicationManagementOperations } from '../../../../../../../../server/management-composition'
import { resolveWorkspacePrincipal } from '../../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../../server/workspace-response'

type Context = { params: { projectId: string; workspaceId: string } }

/**
 * Explicit project-state promotion: archived → active by confirmation at the
 * exact revision the caller observed. The shared management gateway decides
 * authorization and projects stale/unconfirmed refusals; a request without
 * the explicit confirmation never reaches the executor.
 */
async function post(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { projectId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  const candidate = body as Record<string, unknown>
  const input: ApiProjectRestoreInput | null =
    candidate.confirmed === true &&
    typeof candidate.expectedUpdatedAt === 'string' &&
    candidate.expectedUpdatedAt.length > 0
      ? { confirmed: true, expectedUpdatedAt: candidate.expectedUpdatedAt }
      : null
  if (!input) return workspaceInvalidRequestResponse(request)
  const outcome = await applicationManagementOperations().projectPromote({
    confirmed: input.confirmed,
    expectedUpdatedAt: input.expectedUpdatedAt,
    principal: resolution.principal,
    projectId,
    workspaceId,
  })
  if (!outcome.ok) {
    if (outcome.failure.code === 'stale_revision' || outcome.failure.code === 'conflict') {
      return workspaceJsonResponse(
        { code: 'project_conflict', message: outcome.failure.message },
        resolution,
        request,
        { status: 409 }
      )
    }
    return workspaceUnavailableResponse(request)
  }
  const payload: ApiProjectResponse = { project: outcome.value }
  return workspaceJsonResponse(payload, resolution, request)
}

function options(request: Request) {
  return handleDesktopWorkspacePreflight(request)
}
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/projects/$projectId/restore')(
  {
    server: {
      handlers: {
        POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
        OPTIONS: ({ request }) => withRequestScope(() => options(request)),
      },
    },
  }
)
