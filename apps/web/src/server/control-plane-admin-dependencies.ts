import 'server-only'

import { workspaceRolePermissions } from '@adea-ai/auth/authorization'
import { findWorkspaceMembership } from '@adea-ai/db'

import type { AdminRouteDependencies } from './control-plane-admin-routes'
import { controlPlaneScopeResolver } from './control-plane-scope'
import { applicationDatabase } from './database'
import { guardDesktopWorkspaceRequest, withDesktopWorkspaceCors } from './desktop-workspace'
import { authorizeWorkspace } from './workspace-authorization'
import { resolveWorkspacePrincipal } from './workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'

/** The production wiring for the workspace Skills and Cloud connections routes. */
export const controlPlaneAdminDependencies: AdminRouteDependencies = {
  authorize: async (principal, permission, workspaceId) =>
    (await authorizeWorkspace(principal, permission, workspaceId)).allowed,
  canManage: async (principal, workspaceId) => {
    // A display hint for the settings UI, not an authorization decision: the
    // write routes re-check `workspace.update` (and audit it) themselves.
    const membership = await findWorkspaceMembership(applicationDatabase(), workspaceId, principal)
    return Boolean(
      membership &&
      (workspaceRolePermissions[membership.role] as readonly string[]).includes('workspace.update')
    )
  },
  failure: (request, code, message, status) =>
    withDesktopWorkspaceCors(Response.json({ code, message }, { status }), request),
  guard: guardDesktopWorkspaceRequest,
  hop: (workspaceId) => ({ resolveControlPlaneScope: controlPlaneScopeResolver(workspaceId) }),
  invalid: workspaceInvalidRequestResponse,
  json: workspaceJsonResponse,
  resolvePrincipal: (request) => resolveWorkspacePrincipal(request),
  unavailable: workspaceUnavailableResponse,
}
