import { createFileRoute } from '@tanstack/solid-router'

import { controlPlaneAdminDependencies } from '../../../../../../../server/control-plane-admin-dependencies'
import { handleCloudConnectionRotate } from '../../../../../../../server/control-plane-admin-routes'
import { handleDesktopWorkspacePreflight } from '../../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../../server/request-scope'
import { workspaceInvalidRequestResponse } from '../../../../../../../server/workspace-response'

/** Stores a new secret revision for a cloud connection (owners and admins); metadata only comes back. */
export const Route = createFileRoute(
  '/api/workspaces/$workspaceId/cloud-connections/$credentialId/rotate'
)({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        params?.workspaceId && params.credentialId
          ? withRequestScope(() =>
              handleCloudConnectionRotate(
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
