import { createFileRoute } from '@tanstack/solid-router'
import { reorderWorkspaces } from '@adea-ai/db'
import { applicationDatabase } from '../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../server/desktop-workspace'
import { parseWorkspaceOrder } from '../../../../server/workspace-request'
import { resolveWorkspacePrincipal } from '../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../server/workspace-response'
import { withRequestScope } from '../../../../server/request-scope'

async function post(request: Request) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  const ids = parseWorkspaceOrder(body)
  if (!ids) return workspaceInvalidRequestResponse(request)
  try {
    const workspaces = await reorderWorkspaces(applicationDatabase(), resolution.principal, ids)
    return workspaceJsonResponse(workspaces, resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Workspace order conflict')
      return workspaceJsonResponse(
        {
          code: 'workspace_order_conflict',
          message: 'Your workspace list changed. Refresh it and try again.',
        },
        resolution,
        request,
        { status: 409 }
      )
    throw error
  }
}
export const Route = createFileRoute('/api/workspaces/reorder')({
  server: {
    handlers: {
      POST: ({ request }) => withRequestScope(() => post(request)),
      OPTIONS: ({ request }) => withRequestScope(() => handleDesktopWorkspacePreflight(request)),
    },
  },
})
