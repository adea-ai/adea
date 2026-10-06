import { createFileRoute } from '@tanstack/solid-router'
import type { ApiWorkspaceMembersResponse } from '@adea-ai/api-client'
import { listWorkspaceMembersForUser } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../server/request-scope'
import { sharingErrorResponse } from '../../../../../../server/sharing-request'
import { authorizeWorkspace } from '../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../server/workspace-response'

/** Workspace members, for the Share dialog's picker. Display names and roles only. */
async function get(request: Request, workspaceId: string) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'membership.read', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  try {
    const payload: ApiWorkspaceMembersResponse = {
      members: await listWorkspaceMembersForUser(
        applicationDatabase(),
        workspaceId,
        resolution.principal
      ),
    }
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    return sharingErrorResponse(error, resolution, request)
  }
}

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/members')({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        params?.workspaceId
          ? withRequestScope(() => get(request, params.workspaceId))
          : workspaceInvalidRequestResponse(request),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
