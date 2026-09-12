import { createFileRoute } from '@tanstack/react-router'
import { createRuntimeNodeChallenge, readRuntimeNode, RuntimeNodeError } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
  withDesktopWorkspaceCors,
} from '../../../../../../../../server/desktop-workspace'
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

/** One-time nonce the node signs; random, bounded, and single-use by storage. */
function challengeNonce(): string {
  return crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')
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

  const body = (await jsonBody(request)) as Record<string, unknown> | undefined
  const purpose = body?.purpose
  if (purpose !== 'rotate' && purpose !== 'proof') return workspaceInvalidRequestResponse(request)

  const database = applicationDatabase()
  const node = await readRuntimeNode(database, workspaceId, runtimeNodeId).catch(() => null)
  if (!node || node.pairingState === 'revoked') return workspaceUnavailableResponse(request)

  try {
    const challenge = await createRuntimeNodeChallenge(database, {
      createdByUserId: access.resolution.principal.userId,
      kind: node.kind,
      nonce: challengeNonce(),
      purpose,
      runtimeNodeId: node.id,
      workspaceId,
    })
    return workspaceJsonResponse({ challenge, node: null }, access.resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    return runtimeNodeRefusalResponse(request, error)
  }
}

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/runtime-nodes/$runtimeNodeId/challenges'
)({
  server: {
    handlers: {
      POST: ({ request, params }) => post(request, { params }),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
