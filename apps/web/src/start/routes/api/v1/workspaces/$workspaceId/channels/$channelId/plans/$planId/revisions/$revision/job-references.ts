import { createFileRoute } from '@tanstack/solid-router'
import { getCoordinationPlanJobReferences } from '../../../../../../../../../../../../server/coordination-plan-requests'
import { handleDesktopWorkspacePreflight } from '../../../../../../../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../../../../../../../server/request-scope'

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/channels/$channelId/plans/$planId/revisions/$revision/job-references'
)({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        withRequestScope(() => getCoordinationPlanJobReferences(request, params)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
