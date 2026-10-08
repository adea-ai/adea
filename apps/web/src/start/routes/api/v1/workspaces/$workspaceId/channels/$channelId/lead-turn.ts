import { createFileRoute } from '@tanstack/solid-router'
import { handleLeadTurnRequest } from '../../../../../../../../server/lead-turn-routes'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import { handleDesktopWorkspacePreflight } from '../../../../../../../../server/desktop-workspace'
export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/channels/$channelId/lead-turn'
)({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        withRequestScope(() => handleLeadTurnRequest(request, params, 'latest')),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
