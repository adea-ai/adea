import { createFileRoute } from '@tanstack/solid-router'

import { controlPlaneAdminDependencies } from '../../../../../server/control-plane-admin-dependencies'
import {
  handleCloudConnectionCreate,
  handleCloudConnectionsList,
} from '../../../../../server/control-plane-admin-routes'
import { handleDesktopWorkspacePreflight } from '../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../server/request-scope'
import { workspaceInvalidRequestResponse } from '../../../../../server/workspace-response'

/**
 * Workspace settings › Connections › Cloud (ADR 0013): connector credentials
 * held in the Control Plane vault. GET lists metadata (any member); POST
 * stores a new secret once (owners and admins) and returns metadata only.
 */
export const Route = createFileRoute('/api/workspaces/$workspaceId/cloud-connections')({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        params?.workspaceId
          ? withRequestScope(() =>
              handleCloudConnectionsList(request, params.workspaceId, controlPlaneAdminDependencies)
            )
          : workspaceInvalidRequestResponse(request),
      POST: ({ request, params }) =>
        params?.workspaceId
          ? withRequestScope(() =>
              handleCloudConnectionCreate(
                request,
                params.workspaceId,
                controlPlaneAdminDependencies
              )
            )
          : workspaceInvalidRequestResponse(request),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
