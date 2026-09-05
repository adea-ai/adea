import { reopenWorkspace } from '@agent-hq/db'

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

export const runtime = 'nodejs'

export function OPTIONS(request: Request) {
  return handleDesktopWorkspacePreflight(request)
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
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
