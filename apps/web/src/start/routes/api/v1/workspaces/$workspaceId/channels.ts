import { createFileRoute } from '@tanstack/react-router'
import { withRequestScope } from '../../../../../../server/request-scope'
import type { ApiChannelResponse } from '@adea-ai/api-client'
import {
  createDirectAgentChannel,
  createGroupChannel,
  createRoomChannel,
  listChannelsForUser,
} from '@adea-ai/db'

import {
  conversationErrorResponse,
  isConversationUuid,
} from '../../../../../../server/conversation-request'
import { applicationDatabase } from '../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../server/workspace-response'

type Context = { params: { workspaceId: string } }
async function get(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.read', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  return workspaceJsonResponse(
    await listChannelsForUser(applicationDatabase(), workspaceId, resolution.principal),
    resolution,
    request,
    { headers: { 'cache-control': 'private, no-store' } }
  )
}

async function post(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.update', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  const idempotencyKey = request.headers.get('idempotency-key')?.trim()
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (
    !body ||
    !idempotencyKey ||
    idempotencyKey.length > 128 ||
    !['room', 'direct_agent', 'group'].includes(String(body.kind)) ||
    typeof body.title !== 'string' ||
    !body.title.trim() ||
    body.title.length > 120 ||
    (body.taskId !== undefined && !isConversationUuid(body.taskId))
  )
    return workspaceInvalidRequestResponse(request)
  try {
    let channel
    if (body.kind === 'room') {
      if (!isConversationUuid(body.roomId)) return workspaceInvalidRequestResponse(request)
      channel = await createRoomChannel(
        applicationDatabase(),
        workspaceId,
        body.roomId,
        resolution.principal,
        {
          idempotencyKey,
          ...(isConversationUuid(body.taskId) ? { taskId: body.taskId } : {}),
          title: body.title,
        }
      )
    } else if (body.kind === 'direct_agent') {
      if (!isConversationUuid(body.agentId) || idempotencyKey !== `direct-agent:${body.agentId}`)
        return workspaceInvalidRequestResponse(request)
      channel = await createDirectAgentChannel(
        applicationDatabase(),
        workspaceId,
        body.agentId,
        resolution.principal
      )
    } else {
      channel = await createGroupChannel(applicationDatabase(), workspaceId, resolution.principal, {
        idempotencyKey,
        ...(isConversationUuid(body.taskId) ? { taskId: body.taskId } : {}),
        title: body.title,
      })
    }
    const payload: ApiChannelResponse = { channel }
    return workspaceJsonResponse(payload, resolution, request, { status: 201 })
  } catch (error) {
    return conversationErrorResponse(error, resolution, request)
  }
}
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/channels')({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
