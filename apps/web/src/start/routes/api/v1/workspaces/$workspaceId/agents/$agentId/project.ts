import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import type { ApiAgentProjectInput, ApiAgentResponse } from '@adea-ai/api-client'
import { AgentRevisionConflictError, assignAgentToProject } from '@adea-ai/db'
import { applicationDatabase } from '../../../../../../../../server/database'
import { parseAgentProjectChange } from '../../../../../../../../server/agent-edit-request'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../../server/workspace-principal'
import {
  agentRevisionConflictResponse,
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
  let input: ApiAgentProjectInput | null
  try {
    input = parseAgentProjectChange(await request.json())
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (!input) return workspaceInvalidRequestResponse(request)
  try {
    const payload: ApiAgentResponse = {
      agent: await assignAgentToProject(
        applicationDatabase(),
        workspaceId,
        agentId,
        resolution.principal,
        input
      ),
    }
    return workspaceJsonResponse(payload, resolution, request)
  } catch (error) {
    if (error instanceof AgentRevisionConflictError) return agentRevisionConflictResponse(request)
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
