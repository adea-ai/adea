import { createFileRoute } from '@tanstack/solid-router'
import { handleDesktopWorkspacePreflight } from '../../../../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../../../../server/request-scope'
import { handleRuntimeNodePull } from '../../../../../../../../../server/runtime-node-delivery-request'

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/runtime-nodes/$runtimeNodeId/commands/pull'
)({
  server: {
    handlers: {
      POST: ({ request, params }) => withRequestScope(() => handleRuntimeNodePull(request, params)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
