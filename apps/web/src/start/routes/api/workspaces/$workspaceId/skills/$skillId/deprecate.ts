import { createFileRoute } from '@tanstack/solid-router'

import { controlPlaneAdminDependencies } from '../../../../../../../server/control-plane-admin-dependencies'
import { handleCatalogLifecycle } from '../../../../../../../server/control-plane-admin-routes'
import { handleDesktopWorkspacePreflight } from '../../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../../server/request-scope'
import { workspaceInvalidRequestResponse } from '../../../../../../../server/workspace-response'

/** Deprecates a workspace-owned Skill (owners and admins); system items are read-only. */
export const Route = createFileRoute('/api/workspaces/$workspaceId/skills/$skillId/deprecate')({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        params?.workspaceId && params.skillId
          ? withRequestScope(() =>
              handleCatalogLifecycle(
                'skill',
                'deprecate',
                request,
                params.workspaceId,
                params.skillId,
                controlPlaneAdminDependencies
              )
            )
          : workspaceInvalidRequestResponse(request),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
