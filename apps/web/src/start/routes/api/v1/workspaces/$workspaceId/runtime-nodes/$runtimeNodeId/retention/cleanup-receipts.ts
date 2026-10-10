import { createFileRoute } from '@tanstack/solid-router'
import { handleDesktopWorkspacePreflight } from '../../../../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../../../../server/request-scope'
import { handleRuntimeNodeRetentionReceipt } from '../../../../../../../../../server/retention-receipt-request'

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/runtime-nodes/$runtimeNodeId/retention/cleanup-receipts'
)({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        withRequestScope(() => handleRuntimeNodeRetentionReceipt(request, params)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
