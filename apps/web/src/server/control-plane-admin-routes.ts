/**
 * Route handlers for Workspace settings › Skills and › Connections › Cloud
 * (ADR 0013). The file routes under `src/start/routes/api/workspaces/` wire
 * these to the real principal, authorization and Control Plane dependencies
 * (`control-plane-admin-dependencies.ts`); tests inject fakes.
 *
 * Authorization: any workspace member may read; publishing, deprecating,
 * revoking and every cloud connection write need `workspace.update` (owners
 * and admins). A non-member gets the uniform 404; a member without the write
 * permission gets 403. Secrets never reach a log line or a response from here.
 *
 * No `server-only` marker: Bun-run unit tests import this module directly.
 */
import type {
  ApiCatalogListResponse,
  ApiCloudConnectionResponse,
  ApiCloudConnectionsResponse,
} from '@adea-ai/api-client'
import type { UserPrincipalRef, WorkspacePermission } from '@adea-ai/types'

import {
  catalogIdPatterns,
  isCredentialId,
  parseCatalogLifecycle,
  parseCloudConnectionCreate,
  parseCloudConnectionRevoke,
  parseCloudConnectionRotate,
  parseListQuery,
  parseSkillPublish,
} from './control-plane-admin-request'
import {
  changeWorkspaceCatalogLifecycle,
  listWorkspaceCatalog,
  publishWorkspaceSkill,
  type CatalogKind,
  type CatalogLifecycleAction,
} from './control-plane-catalog'
import {
  ControlPlaneProxyError,
  adminCorrelation,
  type ControlPlaneHopDependencies,
} from './control-plane-client'
import {
  createCloudConnection,
  listCloudConnections,
  revokeCloudConnection,
  rotateCloudConnection,
} from './control-plane-credentials-proxy'
import type { WorkspacePrincipalResolution } from './workspace-principal'

/** Request bodies are small JSON; anything larger is refused before parsing. */
const BODY_LIMIT_BYTES = 512 * 1024

export type AdminRouteDependencies = Readonly<{
  /** Desktop-origin guard; a rejection response short-circuits the route. */
  guard(request: Request): Response | null | undefined
  resolvePrincipal(request: Request): Promise<WorkspacePrincipalResolution | null>
  authorize(
    principal: UserPrincipalRef,
    permission: WorkspacePermission,
    workspaceId: string
  ): Promise<boolean>
  /** Whether the principal holds `workspace.update`, without an audit record. */
  canManage(principal: UserPrincipalRef, workspaceId: string): Promise<boolean>
  hop(workspaceId: string): ControlPlaneHopDependencies
  json(
    payload: unknown,
    resolution: WorkspacePrincipalResolution,
    request: Request,
    init?: ResponseInit
  ): Response
  unavailable(request: Request, status?: number): Response
  invalid(request: Request): Response
  failure(request: Request, code: string, message: string, status: number): Response
}>

type Access = 'manage' | 'read'

async function authorized(
  request: Request,
  workspaceId: string,
  access: Access,
  dependencies: AdminRouteDependencies
): Promise<{ resolution: WorkspacePrincipalResolution } | { response: Response }> {
  const rejected = dependencies.guard(request)
  if (rejected) return { response: rejected }
  const resolution = await dependencies.resolvePrincipal(request)
  if (!resolution) return { response: dependencies.unavailable(request, 401) }
  if (!(await dependencies.authorize(resolution.principal, 'workspace.read', workspaceId)))
    return { response: dependencies.unavailable(request) }
  if (
    access === 'manage' &&
    !(await dependencies.authorize(resolution.principal, 'workspace.update', workspaceId))
  )
    return { response: dependencies.unavailable(request, 403) }
  return { resolution }
}

async function readBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) return undefined
  try {
    const text = await request.text()
    if (text.length > BODY_LIMIT_BYTES) return undefined
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function proxyFailure(request: Request, error: unknown, dependencies: AdminRouteDependencies) {
  // Only typed proxy errors carry a code and message; anything else is a
  // fixed 503 so no unexpected error text (or input) reaches the caller.
  if (error instanceof ControlPlaneProxyError)
    return dependencies.failure(request, error.code, error.message, error.status)
  return dependencies.failure(
    request,
    'CONTROL_PLANE_UNAVAILABLE',
    'Control Plane is unavailable',
    503
  )
}

const noStore = { headers: { 'cache-control': 'private, no-store' } }

export async function handleCatalogList(
  kind: CatalogKind,
  request: Request,
  workspaceId: string,
  dependencies: AdminRouteDependencies
): Promise<Response> {
  const access = await authorized(request, workspaceId, 'read', dependencies)
  if ('response' in access) return access.response
  const query = parseListQuery(request)
  if (!query) return dependencies.invalid(request)
  try {
    const [page, canManage] = await Promise.all([
      listWorkspaceCatalog(kind, query, adminCorrelation(request), dependencies.hop(workspaceId)),
      dependencies.canManage(access.resolution.principal, workspaceId),
    ])
    const payload: ApiCatalogListResponse = { canManage, ...page }
    return dependencies.json(payload, access.resolution, request, noStore)
  } catch (error) {
    return proxyFailure(request, error, dependencies)
  }
}

export async function handleSkillPublish(
  request: Request,
  workspaceId: string,
  dependencies: AdminRouteDependencies
): Promise<Response> {
  const access = await authorized(request, workspaceId, 'manage', dependencies)
  if ('response' in access) return access.response
  const input = parseSkillPublish(await readBody(request))
  if (!input) return dependencies.invalid(request)
  try {
    const published = await publishWorkspaceSkill(
      input,
      adminCorrelation(request),
      dependencies.hop(workspaceId)
    )
    return dependencies.json(published, access.resolution, request, { ...noStore, status: 201 })
  } catch (error) {
    return proxyFailure(request, error, dependencies)
  }
}

export async function handleCatalogLifecycle(
  kind: CatalogKind,
  action: CatalogLifecycleAction,
  request: Request,
  workspaceId: string,
  id: string,
  dependencies: AdminRouteDependencies
): Promise<Response> {
  const access = await authorized(request, workspaceId, 'manage', dependencies)
  if ('response' in access) return access.response
  if (!catalogIdPatterns[kind].test(id)) return dependencies.invalid(request)
  const input = parseCatalogLifecycle(kind, await readBody(request))
  if (!input) return dependencies.invalid(request)
  try {
    const changed = await changeWorkspaceCatalogLifecycle(
      kind,
      action,
      { ...input, id },
      adminCorrelation(request),
      dependencies.hop(workspaceId)
    )
    return dependencies.json(changed, access.resolution, request, noStore)
  } catch (error) {
    return proxyFailure(request, error, dependencies)
  }
}

export async function handleCloudConnectionsList(
  request: Request,
  workspaceId: string,
  dependencies: AdminRouteDependencies
): Promise<Response> {
  const access = await authorized(request, workspaceId, 'read', dependencies)
  if ('response' in access) return access.response
  const query = parseListQuery(request)
  if (!query) return dependencies.invalid(request)
  try {
    const [page, canManage] = await Promise.all([
      listCloudConnections(query, adminCorrelation(request), dependencies.hop(workspaceId)),
      dependencies.canManage(access.resolution.principal, workspaceId),
    ])
    const payload: ApiCloudConnectionsResponse = { canManage, ...page }
    return dependencies.json(payload, access.resolution, request, noStore)
  } catch (error) {
    return proxyFailure(request, error, dependencies)
  }
}

export async function handleCloudConnectionCreate(
  request: Request,
  workspaceId: string,
  dependencies: AdminRouteDependencies
): Promise<Response> {
  const access = await authorized(request, workspaceId, 'manage', dependencies)
  if ('response' in access) return access.response
  const input = parseCloudConnectionCreate(await readBody(request))
  if (!input) return dependencies.invalid(request)
  try {
    const payload: ApiCloudConnectionResponse = {
      connection: await createCloudConnection(
        input,
        adminCorrelation(request),
        dependencies.hop(workspaceId)
      ),
    }
    return dependencies.json(payload, access.resolution, request, { ...noStore, status: 201 })
  } catch (error) {
    return proxyFailure(request, error, dependencies)
  }
}

export async function handleCloudConnectionRotate(
  request: Request,
  workspaceId: string,
  credentialId: string,
  dependencies: AdminRouteDependencies
): Promise<Response> {
  const access = await authorized(request, workspaceId, 'manage', dependencies)
  if ('response' in access) return access.response
  if (!isCredentialId(credentialId)) return dependencies.invalid(request)
  const input = parseCloudConnectionRotate(await readBody(request))
  if (!input) return dependencies.invalid(request)
  try {
    const payload: ApiCloudConnectionResponse = {
      connection: await rotateCloudConnection(
        { ...input, credentialId },
        adminCorrelation(request),
        dependencies.hop(workspaceId)
      ),
    }
    return dependencies.json(payload, access.resolution, request, noStore)
  } catch (error) {
    return proxyFailure(request, error, dependencies)
  }
}

export async function handleCloudConnectionRevoke(
  request: Request,
  workspaceId: string,
  credentialId: string,
  dependencies: AdminRouteDependencies
): Promise<Response> {
  const access = await authorized(request, workspaceId, 'manage', dependencies)
  if ('response' in access) return access.response
  if (!isCredentialId(credentialId)) return dependencies.invalid(request)
  const input = parseCloudConnectionRevoke(await readBody(request))
  if (!input) return dependencies.invalid(request)
  try {
    const payload: ApiCloudConnectionResponse = {
      connection: await revokeCloudConnection(
        { ...input, credentialId },
        adminCorrelation(request),
        dependencies.hop(workspaceId)
      ),
    }
    return dependencies.json(payload, access.resolution, request, noStore)
  } catch (error) {
    return proxyFailure(request, error, dependencies)
  }
}
