import { createFileRoute } from '@tanstack/solid-router'

import { controlPlaneAdminDependencies } from '../../../../../../../server/control-plane-admin-dependencies'
import { handleCloudConnectionRevoke } from '../../../../../../../server/control-plane-admin-routes'
import { handleDesktopWorkspacePreflight } from '../../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../../server/request-scope'
import { workspaceInvalidRequestResponse } from '../../../../../../../server/workspace-response'

/** Revokes a cloud connection and its outstanding leases (owners and admins). */
export const Route = createFileRoute(
  '/api/workspaces/$workspaceId/cloud-connections/$credentialId/revoke'
)({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        params?.workspaceId && params.credentialId
          ? withRequestScope(() =>
              handleCloudConnectionRevoke(
                request,
                params.workspaceId,
                params.credentialId,
                controlPlaneAdminDependencies
              )
            )
          : workspaceInvalidRequestResponse(request),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
