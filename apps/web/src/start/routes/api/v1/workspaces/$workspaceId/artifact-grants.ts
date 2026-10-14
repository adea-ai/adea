import { createFileRoute } from '@tanstack/solid-router'
import { registerArtifactReferenceGrant } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../server/desktop-workspace'
import {
  artifactGrantErrorResponse,
  artifactGrantView,
  parseArtifactGrantRegistration,
  readArtifactGrantBody,
} from '../../../../../../server/artifact-grant-request'
import { withRequestScope } from '../../../../../../server/request-scope'
import { isUuid } from '../../../../../../server/sharing-request'
import { authorizeWorkspace } from '../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../server/workspace-response'

/**
 * Issue an artifact-reference grant from the granting workspace. Only owners and
 * admins may issue, which is the role the grant store checks on every path. A
 * replay of an identical live grant returns it unchanged (200). A new grant is
 * created at revision 1 (201). A replay after revocation is refused, never
 * restored: restoring access is the explicit regrant route's job.
 */
async function post(request: Request, workspaceId: string) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (
    !isUuid(workspaceId) ||
    !(await authorizeWorkspace(resolution.principal, 'workspace.update', workspaceId)).allowed
  )
    return workspaceUnavailableResponse(request)
  const body = await readArtifactGrantBody(request)
  const parsed = body && parseArtifactGrantRegistration(body, { regrant: false })
  if (!parsed) return workspaceInvalidRequestResponse(request)
  try {
    const result = await registerArtifactReferenceGrant(
      applicationDatabase(),
      workspaceId,
      resolution.principal,
      parsed.input
    )
    return workspaceJsonResponse(
      { grant: artifactGrantView(result.state, workspaceId), outcome: result.outcome },
      resolution,
      request,
      {
        headers: { 'cache-control': 'no-store' },
        status: result.outcome === 'registered' ? 201 : 200,
      }
    )
  } catch (error) {
    return artifactGrantErrorResponse(error, resolution, request)
  }
}

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/artifact-grants')({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        params?.workspaceId
          ? withRequestScope(() => post(request, params.workspaceId))
          : workspaceInvalidRequestResponse(request),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
