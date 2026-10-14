import { createFileRoute } from '@tanstack/solid-router'

import { applicationDatabase } from '../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../server/desktop-workspace'
import { portableImportResponse } from '../../../../server/portable-workspace-request'
import { withRequestScope } from '../../../../server/request-scope'
import { authorizeWorkspace } from '../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../server/workspace-principal'
import { workspaceUnavailableResponse } from '../../../../server/workspace-response'

/**
 * Restore a portable bundle as a new workspace owned by the caller (M18.02.2,
 * #1226). Creating a workspace requires the same permission as workspace
 * creation; the bundle itself grants nothing.
 */
async function post(request: Request) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  return portableImportResponse(
    request,
    applicationDatabase(),
    resolution,
    async (principal) => (await authorizeWorkspace(principal, 'workspace.create', null)).allowed
  )
}

export const Route = createFileRoute('/api/v1/portable-imports')({
  server: {
    handlers: {
      POST: ({ request }) => withRequestScope(() => post(request)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
