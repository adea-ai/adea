import type { ApiWorkspaceBootstrapResponse } from '@agent-hq/api-client'
import { ensureBootstrapWorkspaces, getUserDisplayName } from '@agent-hq/db'

import { applicationDatabase } from '../../../../server/database'
import {
  desktopTrustedOrigins,
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
  trustedDesktopWorkspaceRequest,
} from '../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../server/workspace-principal'
import {
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../server/workspace-response'

export const runtime = 'nodejs'

export function OPTIONS(request: Request) {
  return handleDesktopWorkspacePreflight(request)
}

export async function POST(request: Request) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request, { createTemporary: true })
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const authorization = await authorizeWorkspace(resolution.principal, 'workspace.create', null)
  if (!authorization.allowed) return workspaceUnavailableResponse(request)

  const workspaces = await ensureBootstrapWorkspaces(
    applicationDatabase(),
    resolution.principal,
  )
  const displayName = await getUserDisplayName(applicationDatabase(), resolution.principal)

  const payload: ApiWorkspaceBootstrapResponse = {
    activeWorkspace: workspaces[0]!,
    principal: {
      ...(displayName ? { displayName } : {}),
      temporary: resolution.temporary,
      userId: resolution.principal.userId,
    },
    sessionRotated: resolution.sessionRotated,
    ...(resolution.createdCredential &&
    trustedDesktopWorkspaceRequest(request, desktopTrustedOrigins())
      ? { temporaryCredential: resolution.createdCredential }
      : {}),
    workspaces,
  }
  return workspaceJsonResponse(payload, resolution, request, {
    headers: { 'cache-control': 'no-store' },
  })
}
