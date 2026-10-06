import { createFileRoute } from '@tanstack/solid-router'
import type { ApiWorkspaceInvitationResponse } from '@adea-ai/api-client'
import { revokeWorkspaceInvitation } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import { isUuid, sharingErrorResponse } from '../../../../../../../../server/sharing-request'
import { authorizeWorkspace } from '../../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../../server/workspace-response'

async function post(request: Request, workspaceId: string, invitationId: string) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'membership.manage', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  if (!isUuid(invitationId)) return workspaceUnavailableResponse(request)
  try {
    const payload: ApiWorkspaceInvitationResponse = {
      invitation: await revokeWorkspaceInvitation(
        applicationDatabase(),
        workspaceId,
        invitationId,
        resolution.principal
      ),
    }
    return workspaceJsonResponse(payload, resolution, request)
  } catch (error) {
    return sharingErrorResponse(error, resolution, request)
  }
}

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/invitations/$invitationId/revoke'
)({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        params?.workspaceId && params.invitationId
          ? withRequestScope(() => post(request, params.workspaceId, params.invitationId))
          : workspaceInvalidRequestResponse(request),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
