import { createFileRoute } from '@tanstack/solid-router'
import type { ApiMessagePage } from '@adea-ai/api-client'
import {
  getChannelForUser,
  listGroupChannelMessagesForUser,
  listMessagesForUser,
} from '@adea-ai/db'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import { postChannelMessage } from '../../../../../../../../server/channel-message-post'

import {
  conversationErrorResponse,
  isConversationUuid,
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

type Context = { params: { channelId: string; workspaceId: string } }
async function get(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { channelId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.read', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  const url = new URL(request.url)
  const afterSequence = url.searchParams.has('afterSequence')
    ? Number(url.searchParams.get('afterSequence'))
    : undefined
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
  const threadRootMessageId = url.searchParams.get('threadRootMessageId') ?? undefined
  if (
    (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) ||
    (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) ||
    (threadRootMessageId !== undefined && !isConversationUuid(threadRootMessageId))
  )
    return workspaceInvalidRequestResponse(request)
  try {
    const channel = await getChannelForUser(
      applicationDatabase(),
      workspaceId,
      channelId,
      resolution.principal
    )
    if (channel.kind === 'group') {
      // Join-point-filtered group history: earlier entries stay held without
      // an explicit audience-aware sharing grant. No caller instant is
      // passed: the shared read evaluates on trusted time it reads itself.
      const payload: ApiMessagePage = await listGroupChannelMessagesForUser(
        applicationDatabase(),
        workspaceId,
        channelId,
        resolution.principal,
        { afterSequence, limit, threadRootMessageId }
      )
      return workspaceJsonResponse(payload, resolution, request, {
        headers: { 'cache-control': 'private, no-store' },
      })
    }
    const payload: ApiMessagePage = await listMessagesForUser(
      applicationDatabase(),
      workspaceId,
      channelId,
      resolution.principal,
      { afterSequence, limit, threadRootMessageId }
    )
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    return conversationErrorResponse(error, resolution, request)
  }
}

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/channels/$channelId/messages'
)({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      POST: ({ request, params }) => withRequestScope(() => postChannelMessage(request, params)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
