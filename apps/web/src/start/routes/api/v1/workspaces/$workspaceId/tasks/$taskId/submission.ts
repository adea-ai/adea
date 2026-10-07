import { createFileRoute } from '@tanstack/solid-router'
import { handleDesktopWorkspacePreflight } from '../../../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import { handleTaskSubmission } from '../../../../../../../../server/task-submission-request'

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/tasks/$taskId/submission')({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => handleTaskSubmission(request, params)),
      POST: ({ request, params }) => withRequestScope(() => handleTaskSubmission(request, params)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
