import { createFileRoute } from '@tanstack/solid-router'
import { findAccountAgent } from '@adea-ai/db'

import { accountAgentLookupResponse } from '../../../../../../server/account-directory-request'
import { applicationDatabase } from '../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../server/request-scope'
import { resolveWorkspacePrincipal } from '../../../../../../server/workspace-principal'
import { workspaceUnavailableResponse } from '../../../../../../server/workspace-response'

/**
 * One account-wide directory Agent by stable id, for deep links (M11.03).
 * Denied and nonexistent are the same response: the lookup is scoped to the
 * caller's own memberships, and invisible rows answer 404 like missing ones.
 */
type Context = { params: { agentId: string } }
async function get(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { agentId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  return accountAgentLookupResponse(
    request,
    applicationDatabase(),
    resolution,
    findAccountAgent,
    agentId
  )
}

export const Route = createFileRoute('/api/v1/account/agents/$agentId')({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
