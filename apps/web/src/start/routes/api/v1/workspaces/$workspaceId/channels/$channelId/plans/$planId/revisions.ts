import { createFileRoute } from '@tanstack/solid-router'
import { postCoordinationPlanRevision } from '../../../../../../../../../../server/coordination-plan-requests'
import { handleDesktopWorkspacePreflight } from '../../../../../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../../../../../server/request-scope'

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/channels/$channelId/plans/$planId/revisions'
)({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        withRequestScope(() => postCoordinationPlanRevision(request, params)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
