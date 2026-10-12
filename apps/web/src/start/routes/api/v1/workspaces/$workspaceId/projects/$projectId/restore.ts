import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import { handleDesktopWorkspacePreflight } from '../../../../../../../../server/desktop-workspace'
import { restoreProjectRequest } from '../../../../../../../../server/project-restore-request'

/**
 * Explicit project-state promotion: archived → active by confirmation at the
 * exact revision the caller observed. The shared management gateway decides
 * authorization and projects stale/unconfirmed refusals; a request without
 * the explicit confirmation never reaches the executor.
 */
function options(request: Request) {
  return handleDesktopWorkspacePreflight(request)
}
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/projects/$projectId/restore')(
  {
    server: {
      handlers: {
        POST: ({ request, params }) =>
          withRequestScope(() => restoreProjectRequest(request, { params })),
        OPTIONS: ({ request }) => withRequestScope(() => options(request)),
      },
    },
  }
)
