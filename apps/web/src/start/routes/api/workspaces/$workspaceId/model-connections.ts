import { createFileRoute } from '@tanstack/solid-router'
import { authorizeLeadTurnFundingBinding } from '@adea-ai/db'
import { controlPlaneAdminDependencies } from '../../../../../server/control-plane-admin-dependencies'
import { applicationDatabase } from '../../../../../server/database'
import { handleDesktopWorkspacePreflight } from '../../../../../server/desktop-workspace'
import {
  handleModelMetadata,
  type ModelMetadataRouteDependencies,
} from '../../../../../server/model-connections-routes'
import { withRequestScope } from '../../../../../server/request-scope'
import { workspaceInvalidRequestResponse } from '../../../../../server/workspace-response'

const dependencies: ModelMetadataRouteDependencies = {
  ...controlPlaneAdminDependencies,
  authorizeFundingBinding: async (principal, workspaceId, binding) => {
    try {
      return await authorizeLeadTurnFundingBinding(
        applicationDatabase(),
        workspaceId,
        principal,
        binding
      )
    } catch {
      return false
    }
  },
}

/** Metadata stays inactive until a qualified host target and supported public SDK are configured. */
export const Route = createFileRoute('/api/workspaces/$workspaceId/model-connections')({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        params?.workspaceId
          ? withRequestScope(() => handleModelMetadata(request, params.workspaceId, dependencies))
          : workspaceInvalidRequestResponse(request),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
