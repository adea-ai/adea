import { createFileRoute } from '@tanstack/solid-router'
import { deleteWorkspace, listWorkspacesForUser, WorkspaceVersionConflictError } from '@adea-ai/db'
import type { ApiWorkspaceDeleteResponse } from '@adea-ai/api-client'
import { applicationDatabase } from '../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../server/desktop-workspace'
import {
  parseWorkspaceDeletion,
  workspaceDeletionOriginAllowed,
} from '../../../../../server/workspace-deletion-request'
import { resolveWorkspacePrincipal } from '../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../server/workspace-response'
import { withRequestScope } from '../../../../../server/request-scope'

async function post(request: Request, workspaceId: string) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  if (!workspaceDeletionOriginAllowed(request)) return workspaceUnavailableResponse(request, 403)
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(workspaceId))
    return workspaceInvalidRequestResponse(request)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  const input = parseWorkspaceDeletion(body)
  if (!input) return workspaceInvalidRequestResponse(request)
  try {
    // Ownership is checked transactionally, including already-deleted receipts.
    // A membership lookup before this call would incorrectly refuse safe retries.
    await deleteWorkspace(applicationDatabase(), workspaceId, resolution.principal, input)
    const workspaces = await listWorkspacesForUser(applicationDatabase(), resolution.principal)
    const payload: ApiWorkspaceDeleteResponse = { deleted: true, workspaceId, workspaces }
    return workspaceJsonResponse(payload, resolution, request)
  } catch (error) {
    if (error instanceof WorkspaceVersionConflictError)
      return workspaceJsonResponse(
        {
          code: 'workspace_version_conflict',
          message: 'Workspace changed. Check its current name and confirm again.',
        },
        resolution,
        request,
        { status: 409 }
      )
    if (error instanceof Error && error.message === 'Workspace unavailable')
      return workspaceUnavailableResponse(request)
    return workspaceJsonResponse(
      { code: 'workspace_deletion_failed', message: 'Workspace could not be deleted. Try again.' },
      resolution,
      request,
      { status: 500 }
    )
  }
}

export const Route = createFileRoute('/api/workspaces/$workspaceId/delete')({
  server: {
    handlers: {
      POST: ({ request, params }) => withRequestScope(() => post(request, params.workspaceId)),
      OPTIONS: ({ request }) => withRequestScope(() => handleDesktopWorkspacePreflight(request)),
    },
  },
})
