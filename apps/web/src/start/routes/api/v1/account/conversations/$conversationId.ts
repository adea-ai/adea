import { createFileRoute } from '@tanstack/solid-router'
import { findAccountConversation } from '@adea-ai/db'

import { accountConversationLookupResponse } from '../../../../../../server/account-directory-request'
import { applicationDatabase } from '../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../server/request-scope'
import { resolveWorkspacePrincipal } from '../../../../../../server/workspace-principal'
import { workspaceUnavailableResponse } from '../../../../../../server/workspace-response'

/**
 * One account-wide inbox conversation by stable id, for deep links (M11.03).
 * Denied and nonexistent are the same response: revoking participation or
 * membership makes the conversation 404 exactly like a missing id, without
 * leaking names or counts.
 */
type Context = { params: { conversationId: string } }
async function get(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { conversationId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  return accountConversationLookupResponse(
    request,
    applicationDatabase(),
    resolution,
    findAccountConversation,
    conversationId
  )
}

export const Route = createFileRoute('/api/v1/account/conversations/$conversationId')({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
