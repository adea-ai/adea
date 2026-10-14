import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../server/request-scope'
import { applicationManagementOperations } from '../../../../../server/management-composition'
import { handleDesktopWorkspacePreflight } from '../../../../../server/desktop-workspace'
import { workspaceArchivePost } from '../../../../../server/workspace-archive-handler'
import { resolveWorkspacePrincipal } from '../../../../../server/workspace-principal'

export const Route = createFileRoute('/api/workspaces/$workspaceId/archive')({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        withRequestScope(() =>
          workspaceArchivePost(request, params.workspaceId, {
            operations: () => applicationManagementOperations(),
            resolvePrincipal: resolveWorkspacePrincipal,
          })
        ),
      OPTIONS: ({ request }) => withRequestScope(() => handleDesktopWorkspacePreflight(request)),
    },
  },
})
