import { createFileRoute } from '@tanstack/solid-router'
import { accountAgentDirectory } from '@adea-ai/db'

import { accountAgentDirectoryResponse } from '../../../../../server/account-directory-request'
import { applicationDatabase } from '../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../server/request-scope'
import { resolveWorkspacePrincipal } from '../../../../../server/workspace-principal'
import { workspaceUnavailableResponse } from '../../../../../server/workspace-response'

/**
 * Account-wide Agents directory (M11.03). No workspace is selected or checked:
 * the query is scoped to the caller's own memberships alone, so the results are
 * identical no matter which workspace is open.
 */
async function get(request: Request) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  return accountAgentDirectoryResponse(
    request,
    applicationDatabase(),
    resolution,
    accountAgentDirectory
  )
}

export const Route = createFileRoute('/api/v1/account/agents')({
  server: {
    handlers: {
      GET: ({ request }) => withRequestScope(() => get(request)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
