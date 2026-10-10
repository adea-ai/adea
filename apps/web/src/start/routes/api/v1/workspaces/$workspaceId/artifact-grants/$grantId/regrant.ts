import { createFileRoute } from '@tanstack/solid-router'
import { regrantArtifactReferenceGrant } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../server/desktop-workspace'
import {
  artifactGrantErrorResponse,
  artifactGrantView,
  parseArtifactGrantRegistration,
  readArtifactGrantBody,
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
 * Explicitly restore a revoked grant, or replay a live one, at the caller's
 * expected revision. A stale or wrong expected revision is refused and changes
 * nothing. Success mints the next revision. Only owners and admins of the
 * granting workspace may regrant, and the store re-checks that authority.
 */
async function post(request: Request, workspaceId: string, grantId: string) {
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
  const parsed = body && parseArtifactGrantRegistration(body, { regrant: true })
  // The path names the grant, so a body that names another grant is refused.
  if (!parsed || parsed.expectedRevision === undefined || parsed.input.grantId !== grantId)
    return workspaceInvalidRequestResponse(request)
  try {
    const result = await regrantArtifactReferenceGrant(
      applicationDatabase(),
      workspaceId,
      resolution.principal,
      parsed.input,
      parsed.expectedRevision
    )
    return workspaceJsonResponse(
      { grant: artifactGrantView(result.state, workspaceId), outcome: result.outcome },
      resolution,
      request,
      { headers: { 'cache-control': 'no-store' } }
    )
  } catch (error) {
    return artifactGrantErrorResponse(error, resolution, request)
  }
}

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/artifact-grants/$grantId/regrant'
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
