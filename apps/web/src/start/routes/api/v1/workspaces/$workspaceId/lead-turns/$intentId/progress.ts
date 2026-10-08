import { createFileRoute } from '@tanstack/solid-router'
import { handleLeadTurnRequest } from '../../../../../../../../server/lead-turn-routes'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import { handleDesktopWorkspacePreflight } from '../../../../../../../../server/desktop-workspace'
export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/lead-turns/$intentId/progress'
)({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        withRequestScope(() => handleLeadTurnRequest(request, params, 'progress')),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
