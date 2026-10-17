import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import type { ApiChannelResponse } from '@adea-ai/api-client'
import {
  getChannelForUser,
  setChannelParticipants,
  setGroupChannelParticipantsFromSelection,
} from '@adea-ai/db'

import {
  conversationErrorResponse,
  parseConversationParticipant,
  parseGroupSelection,
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
async function post(
  request: Request,
  { params }: { params: { channelId: string; workspaceId: string } }
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
  if (!expectedVersion || !body || typeof body !== 'object')
    return workspaceInvalidRequestResponse(request)
  try {
    const existing = await getChannelForUser(
      applicationDatabase(),
      workspaceId,
      channelId,
      resolution.principal
    )
    if (existing.kind === 'group') {
      // Grant-gated roster replacement from a qualified selection. The
      // selection is the whole desired roster; the server issues every grant
      // and the transaction proves management authority, the version and each
      // member's standing. Grant bodies and unqualified participants are not
      // accepted for a group, so nothing a caller writes can stand in for a
      // grant.
      if (Object.keys(body).some((key) => key !== 'selection') || body.selection === undefined)
        return workspaceInvalidRequestResponse(request)
      const selection = parseGroupSelection(body.selection)
      if (!selection) return workspaceInvalidRequestResponse(request)
      const replaced = await setGroupChannelParticipantsFromSelection(
        applicationDatabase(),
        workspaceId,
        channelId,
        resolution.principal,
        { expectedVersion, now: new Date().toISOString(), selection }
      )
      const payload: ApiChannelResponse = { channel: replaced.channel }
      return workspaceJsonResponse(payload, resolution, request)
    }
    if (
      body.selection !== undefined ||
      !Array.isArray(body.participants) ||
      body.participants.length > 100
    )
      return workspaceInvalidRequestResponse(request)
    const participants = body.participants.map(parseConversationParticipant)
    if (participants.some((participant) => !participant))
      return workspaceInvalidRequestResponse(request)
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
export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/channels/$channelId/participants'
)({
  server: {
    handlers: {
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
