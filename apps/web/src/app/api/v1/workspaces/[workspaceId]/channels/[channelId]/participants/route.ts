import type { ApiChannelResponse } from '@adea-ai/api-client'
import { setChannelParticipants } from '@adea-ai/db'

import {
  conversationErrorResponse,
  parseConversationParticipant,
  readConversationVersion,
} from '../../../../../../../../server/conversation-request'
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

export const runtime = 'nodejs'
export const OPTIONS = handleDesktopWorkspacePreflight
export async function POST(
  request: Request,
  { params }: { params: Promise<{ channelId: string; workspaceId: string }> }
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { channelId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.update', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  const expectedVersion = readConversationVersion(request)
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (!expectedVersion || !Array.isArray(body?.participants) || body.participants.length > 100)
    return workspaceInvalidRequestResponse(request)
  const participants = body.participants.map(parseConversationParticipant)
  if (participants.some((participant) => !participant))
    return workspaceInvalidRequestResponse(request)
  try {
    const payload: ApiChannelResponse = {
      channel: await setChannelParticipants(
        applicationDatabase(),
        workspaceId,
        channelId,
        resolution.principal,
        participants as never,
        expectedVersion
      ),
    }
    return workspaceJsonResponse(payload, resolution, request)
  } catch (error) {
    return conversationErrorResponse(error, resolution, request)
  }
}
