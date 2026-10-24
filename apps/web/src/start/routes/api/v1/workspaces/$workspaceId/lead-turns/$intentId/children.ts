import { createFileRoute } from '@tanstack/solid-router'
import {
  handleLeadTurnRequest,
  handleLeadChildPublicationRequest,
} from '../../../../../../../../server/lead-turn-routes'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import { handleDesktopWorkspacePreflight } from '../../../../../../../../server/desktop-workspace'
export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/lead-turns/$intentId/children'
)({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        withRequestScope(() => handleLeadTurnRequest(request, params, 'children')),
      POST: ({ request, params }) =>
        withRequestScope(() => handleLeadChildPublicationRequest(request, params)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
