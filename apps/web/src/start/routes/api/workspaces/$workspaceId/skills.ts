import { createFileRoute } from '@tanstack/solid-router'

import { controlPlaneAdminDependencies } from '../../../../../server/control-plane-admin-dependencies'
import {
  handleCatalogList,
  handleSkillPublish,
} from '../../../../../server/control-plane-admin-routes'
import { handleDesktopWorkspacePreflight } from '../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../server/request-scope'
import { workspaceInvalidRequestResponse } from '../../../../../server/workspace-response'

/**
 * Workspace settings › Skills (ADR 0013): the Skills this workspace sees in
 * the Control Plane catalog (GET, any member) and publishing a workspace
 * Skill version (POST, owners and admins).
 */
export const Route = createFileRoute('/api/workspaces/$workspaceId/skills')({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        params?.workspaceId
          ? withRequestScope(() =>
              handleCatalogList('skill', request, params.workspaceId, controlPlaneAdminDependencies)
            )
          : workspaceInvalidRequestResponse(request),
      POST: ({ request, params }) =>
        params?.workspaceId
          ? withRequestScope(() =>
              handleSkillPublish(request, params.workspaceId, controlPlaneAdminDependencies)
            )
          : workspaceInvalidRequestResponse(request),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
