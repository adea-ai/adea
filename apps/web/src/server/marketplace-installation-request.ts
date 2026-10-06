import type { UserPrincipalRef, WorkspacePermission } from '@adea-ai/types'

import type { ControlPlaneScopeIds } from './control-plane-credential'
import { guardDesktopWorkspaceRequest, withDesktopWorkspaceCors } from './desktop-workspace'
import {
  inboundCorrelation,
  MARKETPLACE_INSTALLATION_ID_PATTERN,
  MarketplaceProxyError,
  proxyMarketplaceInstallationGet,
  proxyMarketplaceUninstall,
  type InboundCorrelation,
  type MarketplaceProxyDependencies,
} from './marketplace-proxy'
import type { WorkspacePrincipalResolution } from './workspace-principal'
import { workspaceJsonResponse, workspaceUnavailableResponse } from './workspace-response'

/**
 * The `/api/marketplace/installations/{get,uninstall}` boundary (ADR 0013).
 *
 * Both are workspace-scoped: the caller names the Adea workspace, is
 * authorized for it, and the proxy reaches only that workspace's mapped
 * Control Plane scope. Reading an installation needs `workspace.read`, as the
 * catalog that lists installations does; uninstalling needs
 * `workspace.update`, exactly as installing does.
 *
 * The route files wire the real principal, authorization and scope lookups;
 * keeping them injectable lets unit tests prove the deny paths without a
 * database.
 */
export type MarketplaceInstallationOperation = 'get' | 'uninstall'

type Proxy = (
  input: Readonly<{ installationId: string; userId: string }>,
  inbound: InboundCorrelation,
  dependencies: MarketplaceProxyDependencies
) => Promise<Response>

export type MarketplaceInstallationRequestDependencies = Readonly<{
  resolvePrincipal: (request: Request) => Promise<WorkspacePrincipalResolution | null>
  authorize: (
    principal: UserPrincipalRef,
    permission: WorkspacePermission,
    workspaceId: string
  ) => Promise<Readonly<{ allowed: boolean }>>
  scopeResolver: (workspaceId: string) => () => Promise<ControlPlaneScopeIds | null>
  proxy?: Proxy
}>

const permissions = {
  get: 'workspace.read',
  uninstall: 'workspace.update',
} as const satisfies Record<MarketplaceInstallationOperation, WorkspacePermission>

const proxies: Record<MarketplaceInstallationOperation, Proxy> = {
  get: proxyMarketplaceInstallationGet,
  uninstall: proxyMarketplaceUninstall,
}

export type MarketplaceInstallationInput = Readonly<{
  installationId: string
  workspaceId: string
}>

/** Strict: exactly the two identifiers, both bounded. */
export function parseMarketplaceInstallationInput(
  value: unknown
): MarketplaceInstallationInput | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => key !== 'installationId' && key !== 'workspaceId'))
    return null
  const { installationId, workspaceId } = input
  if (
    typeof installationId !== 'string' ||
    !MARKETPLACE_INSTALLATION_ID_PATTERN.test(installationId)
  )
    return null
  if (typeof workspaceId !== 'string' || workspaceId.length === 0 || workspaceId.length > 256)
    return null
  return { installationId, workspaceId }
}

export async function handleMarketplaceInstallationRequest(
  operation: MarketplaceInstallationOperation,
  request: Request,
  dependencies: MarketplaceInstallationRequestDependencies
): Promise<Response> {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await dependencies.resolvePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return invalidRequest(request)
  }
  const input = parseMarketplaceInstallationInput(body)
  if (!input) return invalidRequest(request)
  const authorization = await dependencies.authorize(
    resolution.principal,
    permissions[operation],
    input.workspaceId
  )
  if (!authorization.allowed) return workspaceUnavailableResponse(request, 403)
  try {
    const response = await (dependencies.proxy ?? proxies[operation])(
      { installationId: input.installationId, userId: resolution.principal.userId },
      inboundCorrelation(request),
      { resolveControlPlaneScope: dependencies.scopeResolver(input.workspaceId) }
    )
    return workspaceJsonResponse(await response.json(), resolution, request, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    return proxyError(request, error)
  }
}

function invalidRequest(request: Request) {
  return withDesktopWorkspaceCors(
    Response.json(
      { code: 'invalid_request', message: 'Invalid marketplace request' },
      { status: 400 }
    ),
    request
  )
}

function proxyError(request: Request, error: unknown) {
  if (error instanceof MarketplaceProxyError)
    return withDesktopWorkspaceCors(
      Response.json({ code: error.code, message: error.message }, { status: error.status }),
      request
    )
  return withDesktopWorkspaceCors(
    Response.json(
      { code: 'CONTROL_PLANE_UNAVAILABLE', message: 'Control Plane is unavailable' },
      { status: 503 }
    ),
    request
  )
}
