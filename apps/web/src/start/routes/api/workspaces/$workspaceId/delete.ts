import { createFileRoute } from '@tanstack/solid-router'
import { workspaceDeletionState } from '@adea-ai/db'
import { applicationDatabase } from '../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../server/desktop-workspace'
import { resolveWorkspacePrincipal } from '../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../server/workspace-response'
import { workspaceDeletionPost } from '../../../../../server/workspace-deletion-handler'
import { withRequestScope } from '../../../../../server/request-scope'

export const Route = createFileRoute('/api/workspaces/$workspaceId/delete')({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        withRequestScope(async () => {
          const rejected = guardDesktopWorkspaceRequest(request)
          if (rejected) return rejected
          const resolution = await resolveWorkspacePrincipal(request)
          if (!resolution) return workspaceUnavailableResponse(request, 401)
          if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(params.workspaceId))
            return workspaceInvalidRequestResponse(request)
          const state = await workspaceDeletionState(
            applicationDatabase(),
            params.workspaceId,
            resolution.principal
          )
          return state
            ? workspaceJsonResponse(
                { workspaceId: params.workspaceId, state },
                resolution,
                request,
                { headers: { 'cache-control': 'no-store' } }
              )
            : workspaceUnavailableResponse(request)
        }),
      POST: ({ request, params }) =>
        withRequestScope(() =>
          workspaceDeletionPost(request, params.workspaceId, {
            database: applicationDatabase,
            resolvePrincipal: resolveWorkspacePrincipal,
          })
        ),
      OPTIONS: ({ request }) => withRequestScope(() => handleDesktopWorkspacePreflight(request)),
    },
  },
})
