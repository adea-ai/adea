import type { ApiAgentResponse } from '@adea-ai/api-client'
import { archiveAgent, getAgentForUser } from '@adea-ai/db'
import { applicationDatabase } from '../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../server/workspace-principal'
import {
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../server/workspace-response'

export const runtime = 'nodejs'
export const OPTIONS = handleDesktopWorkspacePreflight
type Context = { params: Promise<{ agentId: string; workspaceId: string }> }
export async function GET(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { agentId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.read', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  const agent = await getAgentForUser(
    applicationDatabase(),
    workspaceId,
    agentId,
    resolution.principal
  )
  if (!agent) return workspaceUnavailableResponse(request)
  const payload: ApiAgentResponse = { agent }
  return workspaceJsonResponse(payload, resolution, request, {
    headers: { 'cache-control': 'private, no-store' },
  })
}
export async function DELETE(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { agentId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.update', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  try {
    await archiveAgent(applicationDatabase(), workspaceId, agentId, resolution.principal)
  } catch {
    return workspaceUnavailableResponse(request)
  }
  return workspaceJsonResponse({ archived: true as const }, resolution, request)
}
