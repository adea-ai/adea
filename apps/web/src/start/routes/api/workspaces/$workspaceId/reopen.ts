import { createFileRoute } from '@tanstack/react-router'
import { withRequestScope } from '../../../../../server/request-scope'
import { reopenWorkspace } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../server/workspace-principal'
import {
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../server/workspace-response'
async function post(request: Request, { params }: { params: { workspaceId: string } }) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const workspaceId = (await params).workspaceId
  const authorization = await authorizeWorkspace(
    resolution.principal,
    'workspace.update',
    workspaceId,
    { includeArchived: true }
  )
  if (!authorization.allowed) return workspaceUnavailableResponse(request)
  try {
    const workspace = await reopenWorkspace(
      applicationDatabase(),
      workspaceId,
      resolution.principal
    )
    return workspaceJsonResponse({ workspace }, resolution, request)
  } catch {
    return workspaceUnavailableResponse(request)
  }
}

function options(request: Request) {
  return handleDesktopWorkspacePreflight(request)
}
export const Route = createFileRoute('/api/workspaces/$workspaceId/reopen')({
  server: {
    handlers: {
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => withRequestScope(() => options(request)),
    },
  },
})
