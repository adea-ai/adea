import { createFileRoute } from '@tanstack/solid-router'
import { handleDesktopWorkspacePreflight } from '../../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../../server/request-scope'
import { handleRetentionStatus } from '../../../../../../../server/retention-status-request'
import { authorizeWorkspace } from '../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../server/workspace-principal'

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/retention/status')({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        withRequestScope(() =>
          handleRetentionStatus(request, params, {
            authorize: authorizeWorkspace,
            resolve: resolveWorkspacePrincipal,
          })
        ),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
