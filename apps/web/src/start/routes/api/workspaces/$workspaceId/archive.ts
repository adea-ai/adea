import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../server/request-scope'
import { applicationDatabase } from '../../../../../server/database'
import { handleDesktopWorkspacePreflight } from '../../../../../server/desktop-workspace'
import { workspaceArchivePost } from '../../../../../server/workspace-archive-handler'
import { authorizeWorkspace } from '../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../server/workspace-principal'

export const Route = createFileRoute('/api/workspaces/$workspaceId/archive')({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        withRequestScope(() =>
          workspaceArchivePost(request, params.workspaceId, {
            authorize: async (principal, workspaceId) =>
              (await authorizeWorkspace(principal, 'workspace.archive', workspaceId)).allowed,
            database: applicationDatabase,
            resolvePrincipal: resolveWorkspacePrincipal,
          })
        ),
      OPTIONS: ({ request }) => withRequestScope(() => handleDesktopWorkspacePreflight(request)),
    },
  },
})
