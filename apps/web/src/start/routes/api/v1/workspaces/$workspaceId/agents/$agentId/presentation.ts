import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import type { ApiAgentPresentationInput, ApiAgentResponse } from '@adea-ai/api-client'
import { AgentRevisionConflictError, updateAgentPresentation } from '@adea-ai/db'
import { applicationDatabase } from '../../../../../../../../server/database'
import { parseAgentPresentationChange } from '../../../../../../../../server/agent-edit-request'
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
async function patch(
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
  let input: ApiAgentPresentationInput | null
  try {
    if (Number(request.headers.get('content-length') ?? 0) > 16_384)
      return workspaceInvalidRequestResponse(request)
    input = parseAgentPresentationChange(await request.json())
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (!input) return workspaceInvalidRequestResponse(request)
  try {
    const payload: ApiAgentResponse = {
      agent: await updateAgentPresentation(
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
export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/agents/$agentId/presentation'
)({
  server: {
    handlers: {
      PATCH: ({ request, params }) => withRequestScope(() => patch(request, { params })),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
