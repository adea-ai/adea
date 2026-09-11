import { createFileRoute } from '@tanstack/react-router'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import type { ApiAgentProfileInput, ApiAgentResponse } from '@adea-ai/api-client'
import { changeAgentProfile } from '@adea-ai/db'
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
  let input: ApiAgentProfileInput
  try {
    input = (await request.json()) as ApiAgentProfileInput
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (
    !input ||
    typeof input.profileId !== 'string' ||
    !input.profileId.trim() ||
    typeof input.profileVersion !== 'string' ||
    !input.profileVersion.trim() ||
    (input.profileState !== undefined &&
      !['available', 'deprecated', 'missing'].includes(input.profileState))
  )
    return workspaceInvalidRequestResponse(request)
  try {
    const payload: ApiAgentResponse = {
      agent: await changeAgentProfile(
        applicationDatabase(),
        workspaceId,
        agentId,
        resolution.principal,
        input
      ),
    }
    return workspaceJsonResponse(payload, resolution, request)
  } catch {
    return workspaceUnavailableResponse(request)
  }
}
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/agents/$agentId/profile')({
  server: {
    handlers: {
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
