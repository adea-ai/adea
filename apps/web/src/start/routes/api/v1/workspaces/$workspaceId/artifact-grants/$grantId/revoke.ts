import { createFileRoute } from '@tanstack/solid-router'
import { revokeArtifactReferenceGrant } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../server/desktop-workspace'
import {
  artifactGrantErrorResponse,
  artifactGrantView,
} from '../../../../../../../../server/artifact-grant-request'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import { isUuid } from '../../../../../../../../server/sharing-request'
import { authorizeWorkspace } from '../../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../../server/workspace-response'

/**
 * Revoke a grant from either bound workspace: the granting workspace withdraws
 * it, or the audience renounces its own access. Any member of a bound workspace
 * may do this, which is the store's rule, so the route asks only for membership.
 * The store refuses a workspace that is not bound to the grant. Revoking twice
 * changes nothing.
 */
async function post(request: Request, workspaceId: string, grantId: string) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (
    !isUuid(workspaceId) ||
    !(await authorizeWorkspace(resolution.principal, 'workspace.read', workspaceId)).allowed
  )
    return workspaceUnavailableResponse(request)
  try {
    const state = await revokeArtifactReferenceGrant(
      applicationDatabase(),
      workspaceId,
      resolution.principal,
      grantId
    )
    if (!state)
      return workspaceJsonResponse(
        { code: 'grant_not_registered', message: 'Artifact reference grant not registered' },
        resolution,
        request,
        { status: 404 }
      )
    return workspaceJsonResponse(
      { grant: artifactGrantView(state, workspaceId) },
      resolution,
      request,
      { headers: { 'cache-control': 'no-store' } }
    )
  } catch (error) {
    return artifactGrantErrorResponse(error, resolution, request)
  }
}

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/artifact-grants/$grantId/revoke'
)({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        params?.workspaceId && params.grantId
          ? withRequestScope(() => post(request, params.workspaceId, params.grantId))
          : workspaceInvalidRequestResponse(request),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
