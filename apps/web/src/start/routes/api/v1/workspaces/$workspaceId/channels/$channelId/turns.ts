import { createFileRoute } from '@tanstack/solid-router'
import {
  addressTurnRequest,
  listTurnsRequest,
} from '../../../../../../../../server/addressed-turn-routes'
import { handleDesktopWorkspacePreflight } from '../../../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../../../server/request-scope'

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/channels/$channelId/turns')({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => listTurnsRequest(request, params)),
      POST: ({ request, params }) => withRequestScope(() => addressTurnRequest(request, params)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
