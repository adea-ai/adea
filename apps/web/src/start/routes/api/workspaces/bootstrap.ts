import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../server/request-scope'
import type { ApiWorkspaceBootstrapResponse } from '@adea-ai/api-client'
import { ensureBootstrapWorkspaces, getUserDisplayName } from '@adea-ai/db'

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
async function post(request: Request) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request, { createTemporary: true })
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const authorization = await authorizeWorkspace(resolution.principal, 'workspace.create', null)
  if (!authorization.allowed) return workspaceUnavailableResponse(request)

  // The bootstrap is replay-safe: a repeated call for the same principal
  // converges on the same protected Home instead of minting a second one.
  let workspaces: Awaited<ReturnType<typeof ensureBootstrapWorkspaces>>
  try {
    workspaces = await ensureBootstrapWorkspaces(applicationDatabase(), resolution.principal)
  } catch (error) {
    // A bootstrap that cannot establish exactly one protected personal root has
    // not provisioned Home. Fail closed instead of handing back a session whose
    // workspace list omits it.
    if (error instanceof Error && error.message === 'Workspace personal root unavailable')
      return workspaceUnavailableResponse(request)
    throw error
  }
  const displayName = await getUserDisplayName(applicationDatabase(), resolution.principal)

  // Home is the caller's own protected personal root. It is the only workspace
  // this entry may activate: any other workspace in the list is shared with
  // the caller and is never their active workspace.
  const personalRoots = workspaces.filter((workspace) => workspace.isPersonal)
  if (personalRoots.length !== 1) return workspaceUnavailableResponse(request)

  const payload: ApiWorkspaceBootstrapResponse = {
    activeWorkspace: personalRoots[0] ?? null,
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

function options(request: Request) {
  return handleDesktopWorkspacePreflight(request)
}
export const Route = createFileRoute('/api/workspaces/bootstrap')({
  server: {
    handlers: {
      POST: ({ request }) => withRequestScope(() => post(request)),
      OPTIONS: ({ request }) => withRequestScope(() => options(request)),
    },
  },
})
