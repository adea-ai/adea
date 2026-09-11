import { createFileRoute } from '@tanstack/react-router'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import { handleDesktopWorkspacePreflight } from '../../../../../../../../server/desktop-workspace'
import { handleTaskAction } from '../../../../../../../../server/task-request'
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/tasks/$taskId/start')({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        withRequestScope(() => handleTaskAction('start', request, params)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
