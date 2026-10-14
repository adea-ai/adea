import { createFileRoute } from '@tanstack/solid-router'
import { postCoordinationPlan } from '../../../../../../../../server/coordination-plan-requests'
import { handleDesktopWorkspacePreflight } from '../../../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../../../server/request-scope'

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/channels/$channelId/plans')({
  server: {
    handlers: {
      POST: ({ request, params }) => withRequestScope(() => postCoordinationPlan(request, params)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
