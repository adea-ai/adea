import { createFileRoute } from '@tanstack/solid-router'

import { applicationDatabase } from '../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../server/desktop-workspace'
import { portableWorkspaceExportResponse } from '../../../../../../server/portable-workspace-request'
import { withRequestScope } from '../../../../../../server/request-scope'
import { resolveWorkspacePrincipal } from '../../../../../../server/workspace-principal'
import { workspaceUnavailableResponse } from '../../../../../../server/workspace-response'

type Context = { params: { workspaceId: string } | Promise<{ workspaceId: string }> }

/**
 * The requester's portable export of one workspace (M18.02.2, #1226). Authority
 * is the current membership, read inside the export's own snapshot.
 */
async function get(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  return portableWorkspaceExportResponse(request, applicationDatabase(), resolution, workspaceId)
}

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/portable-export')({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
