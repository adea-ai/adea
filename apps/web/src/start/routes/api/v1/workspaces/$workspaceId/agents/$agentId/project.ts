import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import type { ApiAgentResponse } from '@adea-ai/api-client'
import { assignAgentToProject } from '@adea-ai/db'
import { applicationDatabase } from '../../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../../server/workspace-response'
async function post(
  request: Request,
  { params }: { params: { agentId: string; workspaceId: string } }
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { agentId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.update', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  let projectId: unknown
  try {
    projectId = ((await request.json()) as Record<string, unknown>).projectId
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (projectId !== null && (typeof projectId !== 'string' || !projectId.trim()))
    return workspaceInvalidRequestResponse(request)
  try {
    const payload: ApiAgentResponse = {
      agent: await assignAgentToProject(
        applicationDatabase(),
        workspaceId,
        agentId,
        resolution.principal,
        projectId
      ),
    }
    return workspaceJsonResponse(payload, resolution, request)
  } catch {
    return workspaceUnavailableResponse(request)
  }
}
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/agents/$agentId/project')({
  server: {
    handlers: {
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
