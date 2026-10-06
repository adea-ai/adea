import { createFileRoute } from '@tanstack/solid-router'

import { controlPlaneAdminDependencies } from '../../../../../../server/control-plane-admin-dependencies'
import { handleCatalogList } from '../../../../../../server/control-plane-admin-routes'
import { handleDesktopWorkspacePreflight } from '../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../server/request-scope'
import { workspaceInvalidRequestResponse } from '../../../../../../server/workspace-response'

/** Workspace settings › Skills: the agent profiles this workspace sees (any member). */
export const Route = createFileRoute('/api/workspaces/$workspaceId/skills/profiles')({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        params?.workspaceId
          ? withRequestScope(() =>
              handleCatalogList(
                'profile',
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
