import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../server/request-scope'
import { applicationDatabase } from '../../../../server/database'
import { handleDesktopWorkspacePreflight } from '../../../../server/desktop-workspace'
import { workspaceArchivedGet } from '../../../../server/workspace-archived-handler'
import { resolveWorkspacePrincipal } from '../../../../server/workspace-principal'

export const Route = createFileRoute('/api/workspaces/archived')({
  server: {
    handlers: {
      GET: ({ request }) =>
        withRequestScope(() =>
          workspaceArchivedGet(request, {
            database: applicationDatabase,
            resolvePrincipal: resolveWorkspacePrincipal,
          })
        ),
      OPTIONS: ({ request }) => withRequestScope(() => handleDesktopWorkspacePreflight(request)),
    },
  },
})
