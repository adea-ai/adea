import { NextResponse } from 'next/server'

import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
  withDesktopWorkspaceCors,
} from '../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../server/workspace-principal'
import {
  workspaceUnavailableResponse,
  workspaceJsonResponse,
} from '../../../../server/workspace-response'
import {
  MarketplaceProxyError,
  proxyMarketplaceInstallPlan,
} from '../../../../server/marketplace-proxy'

export const runtime = 'nodejs'

export function OPTIONS(request: Request) {
  return handleDesktopWorkspacePreflight(request)
}

export async function POST(request: Request) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return invalidRequest(request)
  }
  if (!isPlanInput(body)) return invalidRequest(request)
  const workspaceId = body.workspaceIdentity.workspaceId
  const authorization = await authorizeWorkspace(
    resolution.principal,
    'workspace.update',
    workspaceId
  )
  if (!authorization.allowed) return workspaceUnavailableResponse(request, 403)
  try {
    const response = await proxyMarketplaceInstallPlan({
      ...body,
      workspaceIdentity: { ...body.workspaceIdentity, userId: resolution.principal.userId },
    })
    return workspaceJsonResponse(await response.json(), resolution, request, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    return proxyError(request, error)
  }
}

function isPlanInput(value: unknown): value is {
  pluginId: string
  releaseId: string
  instanceId: string
  requestedHarness: string
  workspaceIdentity: { userId: string; workspaceId: string }
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  const identity = input.workspaceIdentity
  return (
    typeof input.pluginId === 'string' &&
    /^plugin:[a-z0-9-]+:[a-z0-9][a-z0-9-]{1,127}$/u.test(input.pluginId) &&
    typeof input.releaseId === 'string' &&
    /^release:[a-f0-9]{64}$/u.test(input.releaseId) &&
    typeof input.instanceId === 'string' &&
    input.instanceId.length > 0 &&
    input.instanceId.length <= 256 &&
    typeof input.requestedHarness === 'string' &&
    input.requestedHarness.length > 0 &&
    input.requestedHarness.length <= 128 &&
    isObject(identity) &&
    typeof identity.workspaceId === 'string' &&
    identity.workspaceId.length > 0 &&
    typeof identity.userId === 'string' &&
    identity.userId.length > 0
  )
}

function invalidRequest(request: Request) {
  return withDesktopWorkspaceCors(
    NextResponse.json(
      { code: 'invalid_request', message: 'Invalid marketplace plan request' },
      { status: 400 }
    ),
    request
  )
}

function proxyError(request: Request, error: unknown) {
  if (error instanceof MarketplaceProxyError)
    return withDesktopWorkspaceCors(
      NextResponse.json({ code: error.code, message: error.message }, { status: error.status }),
      request
    )
  return withDesktopWorkspaceCors(
    NextResponse.json(
      { code: 'CONTROL_PLANE_UNAVAILABLE', message: 'Control Plane is unavailable' },
      { status: 503 }
    ),
    request
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
