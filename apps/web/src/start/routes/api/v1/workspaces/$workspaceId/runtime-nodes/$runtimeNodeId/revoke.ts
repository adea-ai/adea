import { createFileRoute } from '@tanstack/react-router'
import { revokeRuntimeNode, RuntimeNodeError } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
  withDesktopWorkspaceCors,
} from '../../../../../../../../server/desktop-workspace'
import { parseRuntimeNodeRevocation } from '../../../../../../../../server/runtime-node-request'
import { authorizeWorkspace } from '../../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../../server/workspace-response'

/**
 * RuntimeNode registration is privileged and workspace-scoped: only a principal
 * with `runtime.invoke` (owner or admin) may read node identities or open a
 * challenge, and a missing or foreign node always gets the same generic answer
 * so a caller cannot probe for another workspace's hosts.
 */
async function authorize(request: Request, workspaceId: string) {
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return { refusal: workspaceUnavailableResponse(request, 401) } as const
  const authorization = await authorizeWorkspace(
    resolution.principal,
    'runtime.invoke',
    workspaceId
  )
  if (!authorization.allowed) return { refusal: workspaceUnavailableResponse(request) } as const
  return { resolution } as const
}

function runtimeNodeRefusalResponse(request: Request, error: unknown) {
  if (error instanceof RuntimeNodeError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'unauthorized' ? 403 : 409
    return withDesktopWorkspaceCors(
      Response.json({ code: error.code, message: error.message }, { status }),
      request
    )
  }
  return workspaceUnavailableResponse(request)
}

async function jsonBody(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

async function post(
  request: Request,
  { params }: { params: { runtimeNodeId: string; workspaceId: string } }
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { runtimeNodeId, workspaceId } = await params
  const access = await authorize(request, workspaceId)
  if ('refusal' in access) return access.refusal

  const parsed = parseRuntimeNodeRevocation(await jsonBody(request))
  if (!parsed) return workspaceInvalidRequestResponse(request)

  try {
    const node = await revokeRuntimeNode(applicationDatabase(), {
      actorUserId: access.resolution.principal.userId,
      reason: parsed.reason,
      runtimeNodeId,
      workspaceId,
    })
    return workspaceJsonResponse({ node }, access.resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    return runtimeNodeRefusalResponse(request, error)
  }
}

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/runtime-nodes/$runtimeNodeId/revoke'
)({
  server: {
    handlers: {
      POST: ({ request, params }) => post(request, { params }),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
