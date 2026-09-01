import type { ApiWorkspaceBootstrapResponse } from '@agent-hq/api-client'
import { createWorkspaceWithOwner, getUserDisplayName, listWorkspacesForUser } from '@agent-hq/db'

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

  let workspaces = await listWorkspacesForUser(applicationDatabase(), resolution.principal)
  if (workspaces.length === 0) {
    const created = await createWorkspaceWithOwner(applicationDatabase(), {
      idempotencyKey: 'default',
      name: 'My Agent HQ',
      owner: resolution.principal,
    })
    workspaces = [created.workspace]
  }
  const displayName = await getUserDisplayName(applicationDatabase(), resolution.principal)

  const payload: ApiWorkspaceBootstrapResponse = {
    activeWorkspace: workspaces[0]!,
    principal: {
      ...(displayName ? { displayName } : {}),
      temporary: resolution.temporary,
      userId: resolution.principal.userId,
    },
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
