import { createFileRoute } from '@tanstack/solid-router'
import type { ApiProjectMembersResponse } from '@adea-ai/api-client'
import { listProjectMembersForUser } from '@adea-ai/db'

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

/** A project's member list, readable by anyone who can see the project. */
async function get(request: Request, workspaceId: string, projectId: string) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.read', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  if (!isUuid(projectId)) return workspaceUnavailableResponse(request)
  try {
    const payload: ApiProjectMembersResponse = {
      members: await listProjectMembersForUser(
        applicationDatabase(),
        workspaceId,
        projectId,
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

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/projects/$projectId/members')(
  {
    server: {
      handlers: {
        GET: ({ request, params }) =>
          params?.workspaceId && params.projectId
            ? withRequestScope(() => get(request, params.workspaceId, params.projectId))
            : workspaceInvalidRequestResponse(request),
        OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
      },
    },
  }
)
