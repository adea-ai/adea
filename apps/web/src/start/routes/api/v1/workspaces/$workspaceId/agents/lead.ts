import { createFileRoute } from '@tanstack/solid-router'
import { ensureWorkspaceLead, getWorkspaceLeadForUser } from '@adea-ai/db'
import { applicationDatabase } from '../../../../../../../server/database'
import { withRequestScope } from '../../../../../../../server/request-scope'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../server/workspace-response'

async function handle(request: Request, workspaceId: string, provision: boolean) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const permission = provision ? 'workspace.update' : 'workspace.read'
  if (!(await authorizeWorkspace(resolution.principal, permission, workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  if (provision) {
    try {
      if (Number(request.headers.get('content-length') ?? 0) > 512)
        return workspaceInvalidRequestResponse(request)
      const text = await request.text()
      if (text.length > 512) return workspaceInvalidRequestResponse(request)
      const body = JSON.parse(text)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
        return workspaceInvalidRequestResponse(request)
    } catch {
      return workspaceInvalidRequestResponse(request)
    }
  }
  try {
    // Structural provisioning and reads do not call a model or resolve credentials.
    const lead = provision
      ? await ensureWorkspaceLead(applicationDatabase(), workspaceId, resolution.principal)
      : await getWorkspaceLeadForUser(applicationDatabase(), workspaceId, resolution.principal)
    return workspaceJsonResponse({ lead }, resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch {
    return workspaceUnavailableResponse(request)
  }
}

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/agents/lead')({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        withRequestScope(() => handle(request, params.workspaceId, false)),
      POST: ({ request, params }) =>
        withRequestScope(() => handle(request, params.workspaceId, true)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
