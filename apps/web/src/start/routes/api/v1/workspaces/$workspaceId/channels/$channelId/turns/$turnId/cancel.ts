import { createFileRoute } from '@tanstack/solid-router'
import { cancelTurnRequest } from '../../../../../../../../../../server/addressed-turn-routes'
import { handleDesktopWorkspacePreflight } from '../../../../../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../../../../../server/request-scope'

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/channels/$channelId/turns/$turnId/cancel'
)({
  server: {
    handlers: {
      POST: ({ request, params }) => withRequestScope(() => cancelTurnRequest(request, params)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
